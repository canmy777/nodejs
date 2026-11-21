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
    UNSUPPORTED_PLATFORM: '探针执行器需要 Linux 容器'
};

function handleProbeRequest({ pathname, method, req, manager, authenticated, sameOrigin,
    readBody, sendJson, adminPassword, limiter, clientIp }) {
    if (!pathname.startsWith('/admin/api/probe/')) return false;
    if (!authenticated()) { sendJson({ error: '未授权访问' }, 401); return true; }
    const actions = {
        '/admin/api/probe/config': 'save',
        '/admin/api/probe/run': 'run',
        '/admin/api/probe/stop': 'stop'
    };
    const replyError = error => sendJson({ error: MESSAGES[error.code] || '探针操作失败',
        code: Object.hasOwn(MESSAGES, error.code) ? error.code : 'PROBE_FAILED' }, error.status || 500);
    if (pathname === '/admin/api/probe/status') {
        if (method !== 'GET') sendJson({ error: '不支持的请求方法' }, 405);
        else {
            try { sendJson(manager.status()); } catch (error) { replyError(error); }
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
    readBody(data => {
        const key = 'probe:' + clientIp();
        if (limiter.blocked(key)) { sendJson({ error: '密码验证次数过多，请稍后重试' }, 429); return; }
        const supplied = typeof data?.password === 'string' ? data.password : '';
        const expected = adminPassword();
        const digest = value => crypto.createHash('sha256').update(value).digest();
        if (!expected || !crypto.timingSafeEqual(digest(supplied), digest(expected))) {
            limiter.fail(key); sendJson({ error: '管理员密码验证失败' }, 403); return;
        }
        limiter.clear(key);
        try {
            const action = actions[pathname];
            const result = action === 'save' ? manager.save(data.command, data.timeoutSeconds)
                : action === 'run' ? manager.run(data.revision) : manager.stop();
            sendJson(result, action === 'run' ? 202 : 200);
        } catch (error) { replyError(error); }
    });
    return true;
}

module.exports = { handleProbeRequest };
