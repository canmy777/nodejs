'use strict';

const crypto = require('node:crypto');

const MESSAGES = {
    INVALID_COMMAND: '命令不能为空、包含空字符或超过 16 KiB',
    INVALID_TIMEOUT: '最长执行时间须为 10 至 1800 秒的整数，前台常驻探针可设为 0',
    ALREADY_RUNNING: '已有命令正在执行，请先停止或等待结束',
    COMMAND_CHANGED: '命令已变化，请刷新状态并重新确认后执行',
    NO_COMMAND: '请先保存探针命令',
    STORAGE_UNAVAILABLE: '无法读取或保存探针配置，请检查目录权限',
    SHUTTING_DOWN: '服务正在关闭',
    UNSUPPORTED_PLATFORM: '探针执行器需要 Linux 容器',
    INVALID_ENDPOINT: '面板地址须为不带账号、查询参数或片段的 HTTPS 地址',
    INVALID_TOKEN: '请输入有效 Token；切换凭据类型时必须重新填写',
    INVALID_AUTOSTART: '自动启动选项无效',
    INVALID_SHA256: '请输入发布方提供的 64 位 SHA-256',
    HASH_MISMATCH: '文件 SHA-256 不匹配，已拒绝使用',
    INVALID_BINARY: '请选择有效的 Linux ELF 探针程序',
    WRONG_ARCH: '探针架构与当前容器不匹配',
    UNSUPPORTED_ARCH: '当前容器架构暂不支持',
    BINARY_TOO_LARGE: '探针文件不能超过 32 MiB',
    UPLOAD_BUSY: '正在上传探针，请稍后操作',
    UPLOAD_FAILED: '探针上传失败，未替换现有配置',
    KOMARI_NOT_READY: '请先上传探针并保存面板地址和 Token'
};

function handleProbeRequest({ pathname, method, req, manager, authenticated, sameOrigin,
    readBody, sendJson, adminPassword, limiter, clientIp, komari }) {
    if (!pathname.startsWith('/admin/api/probe/')) return false;
    if (!authenticated()) { sendJson({ error: '未授权访问' }, 401); return true; }
    const actions = {
        '/admin/api/probe/config': 'save',
        '/admin/api/probe/run': 'run',
        '/admin/api/probe/stop': 'stop',
        '/admin/api/probe/komari/config': 'komariSave',
        '/admin/api/probe/komari/start': 'komariStart',
        '/admin/api/probe/komari/upload': 'upload'
    };
    const replyError = error => sendJson({ error: MESSAGES[error.code] || '探针操作失败',
        code: Object.hasOwn(MESSAGES, error.code) ? error.code : 'PROBE_FAILED' }, error.status || 500);
    if (pathname === '/admin/api/probe/status') {
        if (method !== 'GET') sendJson({ error: '不支持的请求方法' }, 405);
        else {
            try { sendJson({ ...manager.status(), ...(komari ? { komari: komari.status() } : {}) }); }
            catch (error) { replyError(error); }
        }
        return true;
    }
    if (!actions[pathname]) { sendJson({ error: '接口不存在' }, 404); return true; }
    if (method !== 'POST') { sendJson({ error: '不支持的请求方法' }, 405); return true; }
    // Require a valid HTTPS Origin, not a client-supplied forwarded host.
    let validOrigin = false;
    try {
        const origin = new URL(req.headers.origin);
        validOrigin = origin.protocol === 'https:' && origin.origin === req.headers.origin;
    } catch (_) {}
    if (!validOrigin || !sameOrigin()) {
        sendJson({ error: '请求来源无效，请从本站后台操作' }, 403); return true;
    }
    function reauthenticate(supplied) {
        const key = 'probe:' + clientIp();
        if (limiter.blocked(key)) { sendJson({ error: '密码验证次数过多，请稍后重试' }, 429); return false; }
        const expected = adminPassword();
        const digest = value => crypto.createHash('sha256').update(value).digest();
        if (typeof supplied !== 'string' || !expected || !crypto.timingSafeEqual(digest(supplied), digest(expected))) {
            limiter.fail(key); sendJson({ error: '管理员密码验证失败' }, 403); return false;
        }
        limiter.clear(key);
        return true;
    }
    if (actions[pathname] === 'upload') {
        if (!komari) { sendJson({ error: 'Komari 管理不可用' }, 503); return true; }
        let uploadPassword;
        try { uploadPassword = decodeURIComponent(req.headers['x-probe-password'] || ''); } catch (_) { uploadPassword = ''; }
        if (!reauthenticate(uploadPassword)) return true;
        if (req.headers['content-type'] !== 'application/octet-stream') {
            sendJson({ error: '请使用二进制文件上传' }, 415); return true;
        }
        if (Number(req.headers['content-length']) > 32 * 1024 * 1024) {
            sendJson({ error: MESSAGES.BINARY_TOO_LARGE }, 413); return true;
        }
        komari.upload(req, req.headers['x-probe-sha256'])
            .then(() => sendJson({ ...manager.status(), komari: komari.status() }, 201))
            .catch(replyError);
        return true;
    }
    readBody(data => {
        if (!reauthenticate(data?.password)) return;
        try {
            const action = actions[pathname];
            if (action === 'komariSave' || action === 'komariStart') {
                if (!komari) { sendJson({ error: 'Komari 管理不可用' }, 503); return; }
                if (action === 'komariSave') komari.save(data);
                else komari.start(data.revision);
            } else {
                if (komari && action !== 'stop') komari.ensureIdle();
                if (action === 'save') manager.save(data.command, data.timeoutSeconds);
                else if (action === 'run') manager.run(data.revision);
                else manager.stop();
            }
            sendJson({ ...manager.status(), ...(komari ? { komari: komari.status() } : {}) },
                ['run', 'komariStart'].includes(action) ? 202 : 200);
        } catch (error) { replyError(error); }
    });
    return true;
}

module.exports = { handleProbeRequest };
