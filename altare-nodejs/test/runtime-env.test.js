'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyLegacyRuntimeBundle } = require('../src/runtime-env');

test('legacy runtime credentials survive direct index startup without entering source or child environment', () => {
    const env = { ACCESS_TOKEN: JSON.stringify({ adminPassword: 'test-password', argoToken: 'test-tunnel' }), OTHER: 'unchanged' };
    assert.equal(applyLegacyRuntimeBundle(env), true);
    assert.equal(env.ADMIN_PASSWORD, 'test-password');
    assert.equal(env.ARGO_TOKEN, 'test-tunnel');
    assert.equal(env.ACCESS_TOKEN, undefined);
    assert.equal(env.OTHER, 'unchanged');
});
test('explicit deployed credentials take precedence and ordinary Git tokens are untouched', () => {
    const env = { ACCESS_TOKEN: JSON.stringify({ adminPassword: 'test-password', argoToken: 'test-tunnel' }), ADMIN_PASSWORD: 'test-current', ARGO_TOKEN: 'test-current-tunnel' };
    applyLegacyRuntimeBundle(env);
    assert.equal(env.ADMIN_PASSWORD, 'test-current'); assert.equal(env.ARGO_TOKEN, 'test-current-tunnel');
    for (const raw of ['test-git-token', '{broken', '{}', '[1,2]']) {
        const ordinary = { ACCESS_TOKEN: raw }; assert.equal(applyLegacyRuntimeBundle(ordinary), false); assert.equal(ordinary.ACCESS_TOKEN, raw);
    }
});
test('recognized malformed bundle fails closed without revealing credentials', () => {
    const env = { ACCESS_TOKEN: JSON.stringify({ adminPassword: 'short', argoToken: 'test-tunnel' }) };
    assert.throws(() => applyLegacyRuntimeBundle(env), error => !error.message.includes('short') && !error.message.includes('test-tunnel'));
});
