'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createProbeManager } = require('../src/probe-manager');
const { createKomariManager, validateElf, MAX_BINARY_BYTES } = require('../src/komari-manager');
const { handleProbeRequest } = require('../src/probe-routes');
const { createRateLimiter } = require('../src/security');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nativeBinary = fs.readFileSync('/bin/true');
function setup(t, extra = {}) {
    const root = fs.mkdtempSync('/tmp/opencode/komari-test-');
    const directory = path.join(root, 'private');
    const runner = createProbeManager({ directory, killGraceMs: 80 });
    const manager = createKomariManager({ directory, runner, ...extra });
    t.after(async () => {
        runner.shutdown(); runner.forceCleanup();
        await new Promise(resolve => setTimeout(resolve, 250));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, directory, runner, manager };
}
const profile = { endpoint: 'https://example.test', token: 'test-token', autoStart: false };
async function upload(manager, bytes = nativeBinary) { return manager.upload(Readable.from([bytes]), hash(bytes)); }
async function idle(runner) {
    const start = Date.now();
    while (runner.status().running && Date.now() - start < 3000) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(runner.status().running, false);
}

test('Komari accepts native ELF and hash, atomically stores private file, never executes on upload', async t => {
    const { manager, directory, runner } = setup(t);
    const status = await upload(manager);
    assert.equal(status.binary.sha256, hash(nativeBinary));
    assert.equal(status.binary.size, nativeBinary.length);
    assert.equal(fs.statSync(path.join(directory, status.binary.file)).mode & 0o777, 0o700);
    assert.equal(runner.status().running, false);
    assert.equal(fs.statSync(path.join(directory, 'komari-private.json')).mode & 0o777, 0o600);
});

test('Komari rejects bad hash, non-ELF, wrong architecture, oversize and aborted streams without replacing current binary', async t => {
    const { manager, directory } = setup(t);
    const initial = await upload(manager);
    await assert.rejects(manager.upload(Readable.from([nativeBinary]), '0'.repeat(64)), e => e.code === 'HASH_MISMATCH');
    await assert.rejects(upload(manager, Buffer.alloc(128)), e => e.code === 'INVALID_BINARY');
    const wrong = Buffer.from(nativeBinary); wrong.writeUInt16LE(process.arch === 'arm64' ? 62 : 183, 18);
    await assert.rejects(upload(manager, wrong), e => e.code === 'WRONG_ARCH');
    async function* giant() { for (let i = 0; i < 33; i++) yield Buffer.alloc(1024 * 1024); }
    await assert.rejects(manager.upload(Readable.from(giant()), '0'.repeat(64)), e => e.code === 'BINARY_TOO_LARGE');
    async function* broken() { yield nativeBinary.subarray(0, 100); throw new Error('test-stream-error'); }
    await assert.rejects(manager.upload(Readable.from(broken()), hash(nativeBinary)), e => e.code === 'UPLOAD_FAILED');
    assert.equal(manager.status().binary.file, initial.binary.file);
    assert.equal(manager.status().uploading, false);
    assert.equal(fs.readdirSync(directory).some(x => x.startsWith('.upload-')), false);
});

test('Komari validates endpoint, private Token retention and explicit opt-in autostart', async t => {
    const { manager, directory } = setup(t);
    for (const endpoint of ['http://example.test', 'https://user:pass@example.test', 'https://example.test?a=b', 'https://example.test/#x']) {
        assert.throws(() => manager.save({ ...profile, endpoint }), e => e.code === 'INVALID_ENDPOINT');
    }
    assert.throws(() => manager.save({ ...profile, token: '' }), e => e.code === 'INVALID_TOKEN');
    const status = manager.save(profile);
    assert.equal(status.autoStart, false);
    assert.equal(status.tokenConfigured, true);
    assert.doesNotMatch(JSON.stringify(status), /test-token/);
    manager.save({ ...profile, token: '', autoStart: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'komari-private.json'))).token, 'test-token');
    assert.throws(() => manager.save({ ...profile, token: '', credentialType: 'auto_discovery' }), e => e.code === 'INVALID_TOKEN');
    assert.throws(() => manager.save({ ...profile, token: '', endpoint: 'https://other.test' }), e => e.code === 'INVALID_TOKEN');
});

test('Komari denies concurrent upload, preserves config during upload, and shares one run slot with commands', async t => {
    const { manager, runner } = setup(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    async function* slow() { await gate; yield nativeBinary; }
    const pending = manager.upload(Readable.from(slow()), hash(nativeBinary));
    assert.equal(manager.status().uploading, true);
    assert.throws(() => manager.save(profile), e => e.code === 'UPLOAD_BUSY');
    await assert.rejects(upload(manager), e => e.code === 'UPLOAD_BUSY');
    release(); await pending;
    const config = runner.save('exec sleep 20', 0); runner.run(config.revision);
    assert.throws(() => manager.save(profile), e => e.code === 'ALREADY_RUNNING');
    await assert.rejects(upload(manager), e => e.code === 'ALREADY_RUNNING');
    runner.stop(); await idle(runner);
});

test('Komari start checks revision and file integrity, generates protected config and no Token in args', async t => {
    const { manager, directory, runner } = setup(t);
    await upload(manager); const first = manager.save(profile);
    manager.save({ ...profile, token: '' });
    assert.throws(() => manager.start(first.revision), e => e.code === 'COMMAND_CHANGED');
    manager.start(manager.status().revision);
    await idle(runner);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'komari-private.json')));
    const runtimePath = path.join(directory, 'profile-' + manifest.profile, 'agent.json');
    const runtime = JSON.parse(fs.readFileSync(runtimePath));
    assert.equal(runtime.token, 'test-token');
    assert.equal(runtime.disable_web_ssh, true);
    assert.equal(runtime.disable_auto_update, true);
    assert.equal(fs.statSync(runtimePath).mode & 0o777, 0o600);
    fs.appendFileSync(path.join(directory, manifest.binary.file), 'test');
    assert.throws(() => manager.start(manager.status().revision), e => ['INVALID_BINARY', 'HASH_MISMATCH'].includes(e.code));
});

test('Komari profile survives binary replacement but changes when credentials or endpoint change', async t => {
    const { manager, directory } = setup(t);
    await upload(manager); manager.save({ ...profile, credentialType: 'auto_discovery' });
    const stored = () => JSON.parse(fs.readFileSync(path.join(directory, 'komari-private.json')));
    const initial = stored().profile;
    await upload(manager);
    assert.equal(stored().profile, initial);
    manager.save({ ...profile, token: '', autoStart: true, credentialType: 'auto_discovery' });
    assert.equal(stored().profile, initial);
    manager.save({ ...profile, token: 'new-test-token', credentialType: 'auto_discovery' });
    assert.notEqual(stored().profile, initial);
});

test('Komari autostart is once-only and disabled by default', async t => {
    const { manager, directory, runner } = setup(t);
    await upload(manager); manager.save(profile); manager.autoStart();
    assert.equal(runner.status().run, null);
    manager.save({ ...profile, token: '', autoStart: true });
    const reloaded = createKomariManager({ directory, runner });
    reloaded.autoStart(); await idle(runner);
    const id = runner.status().run.id;
    reloaded.autoStart(); assert.equal(runner.status().run.id, id);
    assert.equal(reloaded.status().reportingStatus, 'unverified');
});

test('Komari mock program receives --config, can run/stop, and auto-discovery cache is private', async t => {
    const { root, directory, manager, runner } = setup(t);
    const src = path.join(root, 'mock.c'); const bin = path.join(root, 'mock-agent');
    fs.writeFileSync(src, '#include <unistd.h>\n#include <stdio.h>\n#include <fcntl.h>\n#include <string.h>\nint main(int argc,char **argv){char p[4096];ssize_t n=readlink("/proc/self/exe",p,sizeof(p)-1);if(n<0||argc!=3||strcmp(argv[1],"--config"))return 9;p[n]=0;char *s=strrchr(p,\'/\');strcpy(s+1,"auto-discovery.json");int f=open(p,O_WRONLY|O_CREAT,0644);if(f<0)return 8;write(f,"test-only",9);close(f);printf("test-only-secret-output\\n");fflush(stdout);for(;;)sleep(1);return 0;}');
    execFileSync('cc', [src, '-o', bin], { stdio: 'pipe' });
    await upload(manager, fs.readFileSync(bin));
    manager.save({ ...profile, credentialType: 'auto_discovery' });
    manager.start(manager.status().revision);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'komari-private.json')));
    const pd = path.join(directory, 'profile-' + manifest.profile);
    const started = Date.now();
    while (!fs.existsSync(path.join(pd, 'auto-discovery.json')) && Date.now() - started < 2000) await new Promise(r => setTimeout(r, 20));
    assert.equal(runner.status().running, true);
    assert.equal(fs.statSync(path.join(pd, 'auto-discovery.json')).mode & 0o777, 0o600);
    const config = JSON.parse(fs.readFileSync(path.join(pd, 'agent.json')));
    assert.equal(config.auto_discovery_key, 'test-token');
    assert.equal(config.token, undefined);
    assert.doesNotMatch(JSON.stringify(runner.status()), /test-only-secret-output|test-token/);
    runner.stop(); await idle(runner);
    const cache = path.join(pd, 'auto-discovery.json');
    const cacheInode = fs.statSync(cache).ino;
    manager.start(manager.status().revision);
    assert.equal(fs.statSync(cache).ino, cacheInode, 'restart retains discovery identity');
    runner.stop(); await idle(runner);
});

test('Komari autostart failure is reported without throwing or repeated attempts', t => {
    const { manager, directory, runner } = setup(t);
    manager.save({ ...profile, autoStart: true });
    assert.doesNotThrow(() => manager.autoStart());
    assert.equal(manager.status().autostartError, 'KOMARI_NOT_READY');
    assert.equal(runner.status().running, false);
    fs.writeFileSync(path.join(directory, 'komari-private.json'), '{bad');
    const other = createKomariManager({ directory, runner });
    assert.doesNotThrow(() => other.autoStart());
});

test('Komari upload route checks Session, HTTPS Origin, password and content type before streaming', async () => {
    let uploads = 0; const replies = [];
    const request = { pathname: '/admin/api/probe/komari/upload', method: 'POST',
        req: { headers: { origin: 'https://example.test', 'content-type': 'application/octet-stream', 'x-probe-password': 'test-password', 'x-probe-sha256': '0'.repeat(64) } },
        manager: { status: () => ({}) }, komari: { async upload() { uploads++; }, status: () => ({}) },
        authenticated: () => true, sameOrigin: () => true, readBody: () => assert.fail('binary upload cannot go through JSON parser'),
        sendJson: (data, status = 200) => replies.push(status), adminPassword: () => 'test-password',
        limiter: createRateLimiter(), clientIp: () => 'test' };
    handleProbeRequest({ ...request, authenticated: () => false }); assert.equal(replies.at(-1), 401);
    handleProbeRequest({ ...request, sameOrigin: () => false }); assert.equal(replies.at(-1), 403);
    handleProbeRequest({ ...request, req: { headers: { ...request.req.headers, 'x-probe-password': 'wrong' } } }); assert.equal(replies.at(-1), 403);
    handleProbeRequest({ ...request, req: { headers: { ...request.req.headers, 'content-type': 'text/plain' } } }); assert.equal(replies.at(-1), 415);
    assert.equal(uploads, 0);
    handleProbeRequest(request); await new Promise(resolve => setImmediate(resolve));
    assert.equal(uploads, 1); assert.equal(replies.at(-1), 201);
});


test('Komari HTTP upload exceeds JSON body limit safely and config/start/stop work through authenticated routes', async t => {
    const { manager, runner } = setup(t);
    const server = http.createServer((req, res) => {
        const sendJson = (body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        handleProbeRequest({ pathname: req.url, method: req.method, req, manager: runner, komari: manager,
            authenticated: () => req.headers.cookie === 'test-session=ok', sameOrigin: () => req.headers.origin === 'https://example.test',
            readBody: callback => { let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => callback(JSON.parse(text))); },
            sendJson, adminPassword: () => 'test-password', limiter: createRateLimiter(), clientIp: () => 'test' });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const headers = { Cookie: 'test-session=ok', Origin: 'https://example.test' };
    const bytes = Buffer.concat([nativeBinary, Buffer.alloc(100000)]);
    let r = await fetch(origin + '/admin/api/probe/komari/upload', { method: 'POST', headers: { ...headers,
        'Content-Type': 'application/octet-stream', 'X-Probe-Password': 'test-password', 'X-Probe-Sha256': hash(bytes) }, body: bytes });
    assert.equal(r.status, 201);
    let body = await r.json(); assert.equal(body.komari.binary.size, bytes.length);
    r = await fetch(origin + '/admin/api/probe/komari/config', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...profile, password: 'test-password' }) });
    assert.equal(r.status, 200); body = await r.json();
    assert.equal(body.komari.tokenConfigured, true); assert.equal(JSON.stringify(body).includes('test-token'), false);
    r = await fetch(origin + '/admin/api/probe/komari/start', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'test-password', revision: body.komari.revision }) });
    assert.equal(r.status, 202); await r.json(); await idle(runner);
    r = await fetch(origin + '/admin/api/probe/status', { headers: { Cookie: 'test-session=ok' } });
    body = await r.json(); assert.equal(body.komari.reportingStatus, 'unverified'); assert.equal(body.run.kind, 'komari');
    r = await fetch(origin + '/admin/api/probe/stop', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'test-password' }) });
    assert.equal(r.status, 200); await r.json();
});
