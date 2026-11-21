'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

class ProbeError extends Error {
    constructor(code, status = 400) {
        super(code);
        this.code = code;
        this.status = status;
    }
}

function createProbeManager({ directory, killGraceMs = 2000 } = {}) {
    const configPath = path.join(directory, 'command.json');
    let active = null;
    let lastRun = null;
    let closed = false;

    function prepareDirectory() {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProbeError('STORAGE_UNAVAILABLE', 500);
        fs.chmodSync(directory, 0o700);
    }

    function readConfig() {
        let fd;
        try {
            fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > MAX_COMMAND_BYTES * 6 + 2048) throw new Error('invalid config');
            const config = JSON.parse(fs.readFileSync(fd, 'utf8'));
            if (typeof config.command !== 'string' || !config.command.trim() ||
                Buffer.byteLength(config.command) > MAX_COMMAND_BYTES || config.command.includes('\0') ||
                !/^[a-f0-9]{32}$/.test(config.revision) ||
                !Number.isInteger(config.timeoutSeconds) ||
                (config.timeoutSeconds !== 0 && (config.timeoutSeconds < 10 || config.timeoutSeconds > 1800))) {
                throw new Error('invalid config');
            }
            fs.fchmodSync(fd, 0o600);
            return config;
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw new ProbeError('STORAGE_UNAVAILABLE', 500);
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
        }
    }

    function groupAlive(pid) {
        try { process.kill(-pid, 0); return true; }
        catch (error) { return error.code !== 'ESRCH'; }
    }

    function finish(run, state) {
        if (active !== run) return;
        clearTimeout(run.timeout);
        clearTimeout(run.forceKill);
        clearInterval(run.monitor);
        run.child.stdin.destroy();
        run.child.stdout.destroy();
        run.child.stderr.destroy();
        lastRun = { ...run.public, state, finishedAt: new Date().toISOString() };
        active = null;
    }

    function sendSignal(run, signal) {
        if (active !== run || !run.child.pid) return;
        try { process.kill(-run.child.pid, signal); }
        catch (error) {
            if (error.code === 'ESRCH') finish(run, run.reason || (run.public.exitCode === 0 ? 'completed' : 'failed'));
            else run.public.signalError = true;
        }
    }

    function stopRun(reason) {
        const run = active;
        if (!run || run.reason) return;
        run.reason = reason;
        run.public.state = 'stopping';
        sendSignal(run, 'SIGTERM');
        if (active === run) {
            run.forceKill = setTimeout(() => sendSignal(run, 'SIGKILL'), killGraceMs);
            run.forceKill.unref();
        }
    }

    function status() {
        const config = readConfig();
        return {
            configured: Boolean(config),
            revision: config?.revision || null,
            savedAt: config?.savedAt || null,
            timeoutSeconds: config?.timeoutSeconds ?? 300,
            running: Boolean(active),
            run: active ? { ...active.public } : lastRun ? { ...lastRun } : null,
            outputPolicy: 'suppressed',
            maxCommandBytes: MAX_COMMAND_BYTES
        };
    }

    function save(command, timeoutSeconds = 300) {
        if (closed) throw new ProbeError('SHUTTING_DOWN', 503);
        if (active) throw new ProbeError('ALREADY_RUNNING', 409);
        if (typeof command !== 'string' || !command.trim() || command.includes('\0') ||
            Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new ProbeError('INVALID_COMMAND');
        if (!Number.isInteger(timeoutSeconds) ||
            (timeoutSeconds !== 0 && (timeoutSeconds < 10 || timeoutSeconds > 1800))) {
            throw new ProbeError('INVALID_TIMEOUT');
        }
        prepareDirectory();
        const config = { command: command.replace(/\r\n?/g, '\n'), timeoutSeconds,
            revision: crypto.randomBytes(16).toString('hex'), savedAt: new Date().toISOString() };
        const temp = path.join(directory, '.command-' + crypto.randomBytes(12).toString('hex'));
        let fd;
        try {
            fd = fs.openSync(temp, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify(config), 'utf8');
            fs.fsyncSync(fd);
            fs.closeSync(fd); fd = undefined;
            fs.renameSync(temp, configPath);
        } catch (_) { throw new ProbeError('STORAGE_UNAVAILABLE', 500); }
        finally {
            if (fd !== undefined) fs.closeSync(fd);
            try { fs.unlinkSync(temp); } catch (_) {}
        }
        return status();
    }

    function run(revision) {
        if (closed) throw new ProbeError('SHUTTING_DOWN', 503);
        if (process.platform === 'win32') throw new ProbeError('UNSUPPORTED_PLATFORM');
        if (active) throw new ProbeError('ALREADY_RUNNING', 409);
        const config = readConfig();
        if (!config) throw new ProbeError('NO_COMMAND', 409);
        if (revision !== config.revision) throw new ProbeError('COMMAND_CHANGED', 409);
        prepareDirectory();
        // Do not pass the app's credentials, NODE_OPTIONS or shell startup hooks.
        const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, TMPDIR: directory,
            LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
        const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
        const args = shell.endsWith('bash') ? ['--noprofile', '--norc', '-s'] : ['-s'];
        const child = spawn(shell, args, { cwd: directory, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const run = { child, reason: null, public: {
            id: crypto.randomBytes(12).toString('hex'), state: 'running',
            startedAt: new Date().toISOString(), finishedAt: null,
            exitCode: null, signal: null, outputBytes: 0
        } };
        active = run;
        const consume = chunk => {
            // Raw command output may echo credentials, so never retain or expose it.
            run.public.outputBytes += chunk.length;
            if (run.public.outputBytes > MAX_OUTPUT_BYTES) stopRun('output_limit');
        };
        child.stdout.on('data', consume);
        child.stderr.on('data', consume);
        child.stdin.on('error', () => {});
        child.on('error', () => {
            if (child.pid && groupAlive(child.pid)) stopRun('failed');
            else finish(run, 'failed');
        });
        child.on('exit', (code, signal) => {
            run.public.exitCode = code;
            run.public.signal = signal;
            if (!child.pid || !groupAlive(child.pid)) finish(run, run.reason || (code === 0 ? 'completed' : 'failed'));
        });
        run.monitor = setInterval(() => {
            if (child.pid && !groupAlive(child.pid)) finish(run, run.reason || (run.public.exitCode === 0 ? 'completed' : 'failed'));
        }, 200);
        run.monitor.unref();
        if (config.timeoutSeconds > 0) {
            run.timeout = setTimeout(() => stopRun('timed_out'), config.timeoutSeconds * 1000);
            run.timeout.unref();
        }
        // Credentials stay out of OS process arguments and the application's log.
        child.stdin.end('umask 077\n' + config.command + '\n');
        return status();
    }

    return {
        status, save, run,
        stop() { stopRun('stopped'); return status(); },
        shutdown() { closed = true; stopRun('stopped'); },
        // The exit hook is synchronous and never targets a saved/reused PID.
        forceCleanup() { if (active) sendSignal(active, 'SIGKILL'); }
    };
}

module.exports = { createProbeManager, ProbeError, MAX_COMMAND_BYTES };
