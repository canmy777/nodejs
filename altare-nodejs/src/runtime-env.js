'use strict';

// Earlier Altare deployments put a JSON bundle into the template ACCESS_TOKEN
// variable. Preserve that source when replacing the old inline bootstrapper.
// An ordinary Git access token is unrelated and must stay untouched.
function applyLegacyRuntimeBundle(env) {
    const raw = env.ACCESS_TOKEN;
    if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return false;
    let bundle;
    try { bundle = JSON.parse(raw); } catch (_) { return false; }
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) ||
        !Object.hasOwn(bundle, 'adminPassword') || !Object.hasOwn(bundle, 'argoToken')) return false;
    if (typeof bundle.adminPassword !== 'string' || bundle.adminPassword.length < 10 ||
        /[\r\n\0]/.test(bundle.adminPassword) || typeof bundle.argoToken !== 'string' ||
        !bundle.argoToken || /[\r\n\0]/.test(bundle.argoToken)) {
        // Fixed message only: never include the bundle or a credential fragment.
        throw new Error('Legacy runtime credentials are invalid; keep the existing startup configuration');
    }
    if (!env.ADMIN_PASSWORD) env.ADMIN_PASSWORD = bundle.adminPassword;
    if (!env.ARGO_TOKEN) env.ARGO_TOKEN = bundle.argoToken;
    delete env.ACCESS_TOKEN;
    return true;
}

module.exports = { applyLegacyRuntimeBundle };
