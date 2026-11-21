'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProbeManager } = require('../src/probe-manager');
const { handleProbeRequest } = require('../src/probe-routes');
const { createRateLimiter } = require('../src/security');

function fixture(t) {
    const root = fs.mkdtempSync('/tmp/opencode/altare-probe-test-');
    const directory = path.join(root, 'private');
    const manager = createProbeManager({ directory, killGraceMs: 100 });
    t.after(async () => {
        manager.shutdown(); manager.forceCleanup();
        await new Promise(resolve => setTimeout(resolve, 250));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, directory, manager };
}
async function done(manager, ms = 5000) {
    const start = Date.now();
    while (manager.status().running && Date.now() - start < ms) {
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(manager.status().running, false, 'managed process must finish');
    return manager.status();
}

test('probe command persists privately without execution or API echo; reload never autoruns', t => {
    const { manager, directory } = fixture(t);
    const marker = path.join(directory, 'marker');
    const command = 'printf test-only > marker';
    const state = manager.save(command, 30);
    assert.equal(state.configured, true);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, 'command.json')).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(state).includes(command), false);
    const second = createProbeManager({ directory });
    assert.equal(second.status().running, false);
    assert.equal(second.status().configured, true);
    assert.equal(fs.existsSync(marker), false);
    second.shutdown();
});

test('probe runs saved command; suppresses output and app environment; reports failure exit code', async t => {
    const { manager, directory } = fixture(t);
    process.env.ALTARE_PROBE_TEST_PRIVATE = 'fictional-value';
    t.after(() => delete process.env.ALTARE_PROBE_TEST_PRIVATE);
    const config = manager.save('printf test-only; printf test-error >&2; printf "%s" "${ALTARE_PROBE_TEST_PRIVATE-unset}" > environment; exit 7', 30);
    manager.run(config.revision);
    const state = await done(manager);
    assert.equal(state.run.exitCode, 7);
    assert.equal(state.run.state, 'failed');
    assert.ok(state.run.outputBytes > 0);
    assert.equal(fs.readFileSync(path.join(directory, 'environment'), 'utf8'), 'unset');
    assert.doesNotMatch(JSON.stringify(state), /test-error|test-only|fictional-value/);
});

test('probe rejects stale revision, concurrent execution and saving over running command', async t => {
    const { manager } = fixture(t);
    const first = manager.save('exit 0', 30);
    const second = manager.save('exec sleep 20', 30);
    assert.throws(() => manager.run(first.revision), error => error.code === 'COMMAND_CHANGED');
    manager.run(second.revision);
    assert.throws(() => manager.run(second.revision), error => error.code === 'ALREADY_RUNNING');
    assert.throws(() => manager.save('exit 0', 30), error => error.code === 'ALREADY_RUNNING');
    manager.stop();
    assert.equal((await done(manager)).run.state, 'stopped');
});

test('probe stop terminates the shell and its foreground child process', async t => {
    const { manager, directory } = fixture(t);
    const config = manager.save('sleep 20 &\necho $! > child.pid\nwait', 30);
    manager.run(config.revision);
    const start = Date.now();
    while (!fs.existsSync(path.join(directory, 'child.pid')) && Date.now() - start < 2000) {
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    const childPid = Number(fs.readFileSync(path.join(directory, 'child.pid'), 'utf8'));
    manager.stop();
    await done(manager);
    try {
        const stat = fs.readFileSync('/proc/' + childPid + '/stat', 'utf8');
        assert.match(stat, /\) Z /, 'any unreaped child must already be a zombie, not a live process');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
});

test('probe validates command size and timeout and refuses corrupt/symlinked saved config', t => {
    const { manager, directory, root } = fixture(t);
    for (const command of ['', ' ', 'a\0b', 'x'.repeat(16385)]) assert.throws(() => manager.save(command));
    for (const timeout of [-1, 9, 1801, 30.5, '30']) assert.throws(() => manager.save('exit 0', timeout));
    manager.save('exit 0', 30);
    const file = path.join(directory, 'command.json');
    fs.writeFileSync(file, '{bad');
    assert.throws(() => manager.status(), error => error.code === 'STORAGE_UNAVAILABLE');
    fs.unlinkSync(file);
    const external = path.join(root, 'other');
    fs.writeFileSync(external, 'not-a-config');
    fs.symlinkSync(external, file);
    assert.throws(() => manager.status(), error => error.code === 'STORAGE_UNAVAILABLE');
});

test('probe terminates excessive output without retaining raw content', async t => {
    const { manager } = fixture(t);
    const config = manager.save('exec yes test-output', 30);
    manager.run(config.revision);
    const state = await done(manager);
    assert.equal(state.run.state, 'output_limit');
    assert.doesNotMatch(JSON.stringify(state), /test-output/);
});

test('probe supports foreground long-running mode with explicit stop', async t => {
    const { manager } = fixture(t);
    const config = manager.save('exec sleep 20', 0);
    assert.equal(config.timeoutSeconds, 0);
    manager.run(config.revision);
    assert.equal(manager.status().running, true);
    manager.stop();
    assert.equal((await done(manager)).run.state, 'stopped');
});

test('probe JSON escaping accepts a valid multi-line command at size limit', t => {
    const { manager } = fixture(t);
    const state = manager.save('\n'.repeat(16000) + 'true', 30);
    assert.equal(state.configured, true);
});

test('probe timeout sends termination to its process group', { timeout: 14000 }, async t => {
    const { manager } = fixture(t);
    const config = manager.save('exec sleep 30', 10);
    manager.run(config.revision);
    assert.equal((await done(manager, 12500)).run.state, 'timed_out');
});

test('probe shutdown cleans up its live task and blocks future execution', async t => {
    const { manager } = fixture(t);
    const config = manager.save('exec sleep 20', 0);
    manager.run(config.revision);
    manager.shutdown();
    await done(manager);
    assert.throws(() => manager.run(config.revision), error => error.code === 'SHUTTING_DOWN');
});

test('probe routes enforce session, POST, Origin, password and rate limit before any mutation', () => {
    let mutated = 0;
    const limiter = createRateLimiter({ limit: 2 });
    const send = (patch = {}, body = {}) => {
        let result;
        const request = {
            pathname: '/admin/api/probe/config', method: 'POST', req: { headers: { origin: 'https://example.test' } },
            manager: { save() { mutated++; return { configured: true }; }, status() { return { configured: false }; },
                run() { mutated++; return { running: true }; }, stop() { mutated++; return {}; } },
            authenticated: () => true, sameOrigin: () => true,
            readBody: callback => callback(body), sendJson: (data, status = 200) => { result = { data, status }; },
            adminPassword: () => 'test-password', limiter, clientIp: () => 'test-client', ...patch
        };
        assert.equal(handleProbeRequest(request), true);
        return result;
    };
    assert.equal(send({ authenticated: () => false }).status, 401);
    assert.equal(send({ method: 'GET' }).status, 405);
    assert.equal(send({ req: { headers: {} } }).status, 403);
    assert.equal(send({ sameOrigin: () => false }).status, 403);
    assert.equal(send({ req: { headers: { origin: 'http://example.test' } } }).status, 403);
    assert.equal(send({ req: { headers: { origin: 'https://example.test/path' } } }).status, 403);
    assert.equal(mutated, 0);
    assert.equal(send({}, { password: 'wrong' }).status, 403);
    assert.equal(send({}, { password: 'wrong' }).status, 403);
    assert.equal(send({}, { password: 'test-password' }).status, 429);
    limiter.clear('probe:test-client');
    assert.equal(send({}, { password: 'test-password' }).status, 200);
    assert.equal(mutated, 1);
    assert.equal(send({ pathname: '/admin/api/probe/run' }, { password: 'test-password' }).status, 202);
    assert.equal(send({ pathname: '/admin/api/probe/stop' }, { password: 'test-password' }).status, 200);
    assert.equal(send({ pathname: '/admin/api/probe/status', method: 'GET' }).status, 200);
    assert.equal(send({ pathname: '/admin/api/probe/unknown' }).status, 404);
});
