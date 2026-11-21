'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ProbeError } = require('./probe-manager');

const MAX_BINARY_BYTES = 32 * 1024 * 1024;
const ARCHITECTURES = { x64: { machine: 62, bits: 2, label: 'amd64' },
    arm64: { machine: 183, bits: 2, label: 'arm64' },
    ia32: { machine: 3, bits: 1, label: '386' },
    arm: { machine: 40, bits: 1, label: 'arm' } };

function validateElf(header, arch) {
    const expected = ARCHITECTURES[arch];
    if (!expected) throw new ProbeError('UNSUPPORTED_ARCH');
    if (header.length < 52 || !header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
        header[5] !== 1 || header[6] !== 1 || ![2, 3].includes(header.readUInt16LE(16))) {
        throw new ProbeError('INVALID_BINARY');
    }
    if (header[4] !== expected.bits || header.readUInt16LE(18) !== expected.machine) {
        throw new ProbeError('WRONG_ARCH');
    }
    return expected.label;
}

function createKomariManager({ directory, runner, arch = process.arch, platform = process.platform }) {
    const manifest = path.join(directory, 'komari-private.json');
    let uploading = false;
    let autostartAttempted = false;
    let autostartError = null;

    function prepare() {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProbeError('STORAGE_UNAVAILABLE', 500);
        fs.chmodSync(directory, 0o700);
    }
    function atomic(file, data, mode = 0o600) {
        prepare();
        const temp = path.join(directory, '.komari-' + crypto.randomBytes(12).toString('hex'));
        let fd;
        try {
            fd = fs.openSync(temp, 'wx', mode);
            fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd);
            fs.closeSync(fd); fd = undefined;
            fs.renameSync(temp, file);
        } catch (_) { throw new ProbeError('STORAGE_UNAVAILABLE', 500); }
        finally {
            if (fd !== undefined) fs.closeSync(fd);
            try { fs.unlinkSync(temp); } catch (_) {}
        }
    }
    function read() {
        let fd;
        try {
            // Refuse directory symlinks as well as a symlinked manifest.
            if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('directory symlink');
            fd = fs.openSync(manifest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            if (fs.fstatSync(fd).size > 16384) throw new Error('large manifest');
            const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
            if (!data || typeof data !== 'object' || !/^[a-f0-9]{32}$/.test(data.revision) ||
                (data.token !== undefined && typeof data.token !== 'string') ||
                (data.endpoint !== undefined && typeof data.endpoint !== 'string') ||
                (data.autoStart !== undefined && typeof data.autoStart !== 'boolean') ||
                (data.binary && (!/^[a-f0-9]{64}$/.test(data.binary.sha256) ||
                    !/^agent-[a-f0-9]{24}$/.test(data.binary.file) ||
                    !Number.isInteger(data.binary.size) || data.binary.size < 64 || data.binary.size > MAX_BINARY_BYTES))) throw new Error('invalid manifest');
            fs.fchmodSync(fd, 0o600);
            return data;
        } catch (error) {
            if (error.code === 'ENOENT') return {};
            throw new ProbeError('STORAGE_UNAVAILABLE', 500);
        } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    function busy() {
        if (uploading) throw new ProbeError('UPLOAD_BUSY', 409);
        if (runner.status().running) throw new ProbeError('ALREADY_RUNNING', 409);
    }
    function publicStatus(data = read()) {
        return {
            platform, arch: ARCHITECTURES[arch]?.label || arch,
            maxBinaryBytes: MAX_BINARY_BYTES, uploading,
            endpoint: data.endpoint || '', tokenConfigured: Boolean(data.token),
            credentialType: data.credentialType || 'token',
            autoStart: data.autoStart === true, configured: Boolean(data.endpoint && data.token),
            revision: data.revision || null,
            binary: data.binary ? { file: data.binary.file, sha256: data.binary.sha256, size: data.binary.size,
                arch: data.binary.arch, uploadedAt: data.binary.uploadedAt } : null,
            autostartError,
            reportingStatus: 'unverified'
        };
    }
    function store(data) {
        data.revision = crypto.randomBytes(16).toString('hex');
        atomic(manifest, data);
        return publicStatus(data);
    }
    function save({ endpoint, token, autoStart, credentialType = 'token' }) {
        busy();
        let address;
        try {
            if (typeof endpoint !== 'string' || endpoint.length > 2048) throw new Error();
            address = new URL(endpoint);
            if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash) throw new Error();
        } catch (_) { throw new ProbeError('INVALID_ENDPOINT'); }
        if (typeof token !== 'string' || token.length > 4096 || (token && !/^[!-~]+$/.test(token))) throw new ProbeError('INVALID_TOKEN');
        if (typeof autoStart !== 'boolean') throw new ProbeError('INVALID_AUTOSTART');
        if (!['token', 'auto_discovery'].includes(credentialType)) throw new ProbeError('INVALID_TOKEN');
        const data = read();
        const nextToken = token || data.token;
        if (!nextToken || (!token && credentialType !== (data.credentialType || 'token'))) throw new ProbeError('INVALID_TOKEN');
        const normalizedEndpoint = address.href.replace(/\/$/, '');
        if (!token && data.endpoint && normalizedEndpoint !== data.endpoint) throw new ProbeError('INVALID_TOKEN');
        const credentialsChanged = normalizedEndpoint !== data.endpoint || nextToken !== data.token ||
            credentialType !== (data.credentialType || 'token');
        const profile = credentialsChanged || !data.profile ? crypto.randomBytes(12).toString('hex') : data.profile;
        return store({ ...data, endpoint: normalizedEndpoint, token: nextToken,
            profile, credentialType, autoStart, savedAt: new Date().toISOString() });
    }
    async function upload(stream, expectedHash) {
        busy();
        if (platform !== 'linux') throw new ProbeError('UNSUPPORTED_PLATFORM');
        if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) throw new ProbeError('INVALID_SHA256');
        uploading = true;
        let fd;
        let temp;
        let installed;
        const deadline = setTimeout(() => {
            if (typeof stream.destroy === 'function') stream.destroy(new Error('upload timed out'));
        }, 90000);
        deadline.unref();
        try {
            prepare();
            temp = path.join(directory, '.upload-' + crypto.randomBytes(12).toString('hex'));
            fd = fs.openSync(temp, 'wx', 0o600);
            const hash = crypto.createHash('sha256');
            let size = 0;
            let header = Buffer.alloc(0);
            for await (const chunk of stream) {
                size += chunk.length;
                if (size > MAX_BINARY_BYTES) throw new ProbeError('BINARY_TOO_LARGE', 413);
                if (header.length < 64) header = Buffer.concat([header, chunk.subarray(0, 64 - header.length)]);
                hash.update(chunk);
                let offset = 0;
                while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset);
            }
            if (size < 64) throw new ProbeError('INVALID_BINARY');
            const architecture = validateElf(header, arch);
            const sha256 = hash.digest('hex');
            if (sha256 !== expectedHash.toLowerCase()) throw new ProbeError('HASH_MISMATCH');
            fs.fsyncSync(fd); fs.fchmodSync(fd, 0o700); fs.closeSync(fd); fd = undefined;
            const current = read();
            // Random immutable path; submitted filenames are never used as paths.
            const file = 'agent-' + crypto.randomBytes(12).toString('hex');
            installed = path.join(directory, file);
            fs.renameSync(temp, installed); temp = null;
            const result = store({ ...current, binary: { file, sha256, size, arch: architecture,
                uploadedAt: new Date().toISOString() } });
            installed = null;
            // Only remove the previous managed binary, never arbitrary user files.
            if (current.binary?.file && /^agent-[a-f0-9]{24}$/.test(current.binary.file)) {
                try { fs.unlinkSync(path.join(directory, current.binary.file)); } catch (_) {}
            }
            return result;
        } catch (error) {
            if (error instanceof ProbeError) throw error;
            throw new ProbeError('UPLOAD_FAILED', 500);
        } finally {
            clearTimeout(deadline);
            if (fd !== undefined) fs.closeSync(fd);
            for (const file of [temp, installed]) if (file) { try { fs.unlinkSync(file); } catch (_) {} }
            uploading = false;
        }
    }
    function start(revision) {
        busy();
        const data = read();
        if (revision !== data.revision) throw new ProbeError('COMMAND_CHANGED', 409);
        if (!data.endpoint || !data.token || !data.binary) throw new ProbeError('KOMARI_NOT_READY', 409);
        if (!/^agent-[a-f0-9]{24}$/.test(data.binary.file)) throw new ProbeError('INVALID_BINARY');
        const file = path.join(directory, data.binary.file);
        let fd;
        try {
            if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('directory symlink');
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size !== data.binary.size) throw new Error();
            const hash = crypto.createHash('sha256'); const buffer = Buffer.alloc(65536);
            let readBytes;
            while ((readBytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, readBytes));
            if (hash.digest('hex') !== data.binary.sha256) throw new ProbeError('HASH_MISMATCH');
            const header = Buffer.alloc(64); fs.readSync(fd, header, 0, 64, 0); validateElf(header, arch);
        } catch (error) {
            if (error instanceof ProbeError) throw error;
            throw new ProbeError('INVALID_BINARY');
        } finally { if (fd !== undefined) fs.closeSync(fd); }
        const runtimeConfig = { endpoint: data.endpoint,
            disable_auto_update: true, disable_web_ssh: true, ignore_unsafe_cert: false };
        runtimeConfig[data.credentialType === 'auto_discovery' ? 'auto_discovery_key' : 'token'] = data.token;
        if (!/^[a-f0-9]{24}$/.test(data.profile || '')) throw new ProbeError('STORAGE_UNAVAILABLE', 500);
        const profileDirectory = path.join(directory, 'profile-' + data.profile);
        fs.mkdirSync(profileDirectory, { mode: 0o700, recursive: true });
        const profileStat = fs.lstatSync(profileDirectory);
        if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) throw new ProbeError('STORAGE_UNAVAILABLE', 500);
        fs.chmodSync(profileDirectory, 0o700);
        const agentConfig = path.join(profileDirectory, 'agent.json');
        atomic(agentConfig, runtimeConfig);
        const executable = path.join(profileDirectory, 'komari-agent');
        const tempExecutable = path.join(profileDirectory, '.agent-' + crypto.randomBytes(12).toString('hex'));
        try {
            fs.copyFileSync(file, tempExecutable, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(tempExecutable, 0o700);
            fs.renameSync(tempExecutable, executable);
        } finally { try { fs.unlinkSync(tempExecutable); } catch (_) {} }
        autostartError = null;
        // Komari caches discovery credentials beside its executable, not beside --config.
        // A profile directory isolates the cache per endpoint/credential; 077 protects new files.
        runner.runExecutable('/bin/sh', ['-c', 'umask 077; exec "$1" --config "$2"', 'komari', executable, agentConfig]);
        return publicStatus(data);
    }
    function autoStart() {
        if (autostartAttempted) return;
        autostartAttempted = true;
        try {
            const data = read();
            if (data.autoStart === true) start(data.revision);
        } catch (error) { autostartError = error instanceof ProbeError ? error.code : 'AUTOSTART_FAILED'; }
    }
    return { status: publicStatus, save, upload, start, autoStart, ensureIdle: busy };
}

module.exports = { createKomariManager, validateElf, MAX_BINARY_BYTES };
