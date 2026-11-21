'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../index.js'), 'utf8').replace(/\r\n/g, '\n');
const machineTag = () => 'SOC-test';
const regionTitle = () => 'SOC-test';
const escapeHtml = value => String(value);
function declaration(name) {
    const start = source.indexOf('function ' + name + '(');
    return source.slice(start, source.indexOf('\n}', start) + 2);
}
test('probe panel imports commands as text, suppresses saved text and separates save from execution', async () => {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value: '', textContent: '', style: {}, dataset: {}, disabled: false });
        return elements.get(id);
    };
    const calls = [];
    const state = { configured: true, revision: 'test-revision', timeoutSeconds: 0, savedAt: 'test-time', running: false, run: null };
    const context = vm.createContext({
        document: { getElementById: element }, location: { origin: 'https://example.test' }, machineTag, regionTitle, escapeHtml,
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url.startsWith('/admin/api/probe/')) return { ok: true, json: async () => state };
            return { ok: false, status: 401, json: async () => ({}) };
        },
        console, setInterval: () => 1, clearInterval() {}, setTimeout: () => 0
    });
    vm.runInContext(declaration('renderAdminDashboardPage'), context);
    const html = vm.runInContext('renderAdminDashboardPage()', context);
    assert.match(html, /id="menu_probe"/);
    assert.match(html, /id="panel_probe"/);
    assert.match(html, /id="probe_password"/);
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
    vm.runInContext('showToast = () => {}; confirmAction = async () => true;', context);
    context.fileEvent = { target: { files: [{ name: 'probe.sh', size: 20, text: async () => '<script>test-only</script>' }], value: 'test-file' } };
    await vm.runInContext('importProbeCommand(fileEvent)', context);
    assert.equal(element('probe_command').value, '<script>test-only</script>');
    assert.equal(context.fileEvent.target.value, '');
    element('probe_password').value = 'test-password';
    element('probe_timeout').value = '0';
    await vm.runInContext("probeAction('config')", context);
    assert.equal(element('probe_command').value, '');
    assert.equal(element('probe_password').value, '');
    assert.match(element('probe_config_status').textContent, /前台常驻/);
    assert.equal(calls.filter(x => x.url === '/admin/api/probe/run').length, 0);
    element('probe_password').value = 'test-password';
    await vm.runInContext("probeAction('run')", context);
    const execution = calls.find(x => x.url === '/admin/api/probe/run');
    assert.equal(execution.options.method, 'POST');
    assert.equal(JSON.parse(execution.options.body).revision, 'test-revision');
    assert.equal(element('probe_password').value, '');
    element('probe_command').value = 'unsaved';
    element('probe_password').value = 'test-password';
    await vm.runInContext("probeAction('run')", context);
    assert.equal(calls.filter(x => x.url === '/admin/api/probe/run').length, 1);
    element('probe_command').value = '';
    vm.runInContext("confirmAction = async () => { probeRevision = 'newer-revision'; return true; };", context);
    await vm.runInContext("probeAction('run')", context);
    const executions = calls.filter(x => x.url === '/admin/api/probe/run');
    assert.equal(JSON.parse(executions.at(-1).options.body).revision, 'test-revision', 'confirmation binds the command revision before awaiting the dialog');
});

test('Komari UI uploads binary separately, clears credentials and never saves while starting', async () => {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value: '', files: [], checked: false, textContent: '', style: {}, dataset: {}, disabled: false });
        return elements.get(id);
    };
    const calls = [];
    const state = { configured: false, revision: null, running: false, run: null, komari: {
        configured: true, revision: 'komari-revision', platform: 'linux', arch: 'arm64', endpoint: 'https://example.test',
        credentialType: 'token', tokenConfigured: true, autoStart: false,
        binary: { size: 100, arch: 'arm64', sha256: 'a'.repeat(64) }
    } };
    const context = vm.createContext({ document: { getElementById: element }, location: { origin: 'https://example.test' },
        machineTag, regionTitle, escapeHtml, console, setTimeout: () => 0, setInterval: () => 1, clearInterval() {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url.startsWith('/admin/api/probe/')) return { ok: true, json: async () => state };
            return { ok: false, status: 401, json: async () => ({}) };
        } });
    vm.runInContext(declaration('renderAdminDashboardPage'), context);
    const html = vm.runInContext('renderAdminDashboardPage()', context);
    assert.match(html, /id="komari_binary"/); assert.match(html, /id="komari_autostart"/);
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
    vm.runInContext('showToast = () => {}; confirmAction = async () => true;', context);
    element('komari_binary').files = [{ name: 'test-agent', size: 100 }];
    element('komari_sha256').value = 'a'.repeat(64); element('probe_password').value = 'test-password';
    await vm.runInContext('uploadKomari()', context);
    const uploadCall = calls.find(x => x.url.endsWith('/komari/upload'));
    assert.equal(uploadCall.options.body, element('komari_binary').files[0]);
    assert.equal(uploadCall.options.headers['Content-Type'], 'application/octet-stream');
    assert.equal(element('probe_password').value, '');
    element('komari_endpoint').value = 'https://new.test'; element('komari_token').value = 'test-token';
    element('komari_autostart').checked = true; element('probe_password').value = 'test-password';
    vm.runInContext('markKomariDirty()', context);
    await vm.runInContext("komariAction('config')", context);
    const saved = JSON.parse(calls.find(x => x.url.endsWith('/komari/config')).options.body);
    assert.equal(saved.token, 'test-token'); assert.equal(saved.autoStart, true);
    assert.equal(element('komari_token').value, ''); assert.equal(element('probe_password').value, '');
    element('probe_password').value = 'test-password';
    await vm.runInContext("komariAction('start')", context);
    const started = JSON.parse(calls.find(x => x.url.endsWith('/komari/start')).options.body);
    assert.equal(started.revision, 'komari-revision'); assert.equal(started.token, undefined);
    assert.match(element('komari_config_status').textContent, /上报状态待核验/);
});
