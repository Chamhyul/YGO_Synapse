'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createLookupMaintenance } = require('../services/membershipCsvLookupMaintenance');
const response = () => ({ code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(v) { this.code = v; return this; }, json(v) { this.body = v; return this; } });
test('비공개 운영 도구는 명시적인 preview와 정확한 버전 준비만 전달한다', async () => {
  const calls = [], handler = createLookupMaintenance({ select: () => ({ config: { mode: 'production' }, storage: { membershipCsv: {
    prepareActiveLookup: async body => { calls.push(body); return { count: 3, indexBytes: 500, sourceUnchanged: true }; },
  } } }) });
  for (const body of [{ dryRun: true }, { dryRun: false, revision: 'a'.repeat(32), fingerprint: 'b'.repeat(64) }]) {
    const res = response(); await handler({ method: 'POST', body }, res); assert.equal(res.code, 200); assert.equal(res.body.sourceUnchanged, true);
  }
  assert.equal(calls.length, 2);
  for (const req of [{ method: 'GET' }, { method: 'POST', body: {} }, { method: 'POST', body: { dryRun: false } }, { method: 'POST', body: { dryRun: true, uid: 'foreign' } }]) {
    const res = response(); await handler(req, res); assert([400, 405].includes(res.code));
  }
  assert.equal(calls.length, 2);
});
test('에뮬레이터·설정 장애·자료 장애는 원문 없이 닫는다', async () => {
  for (const select of [() => ({ config: { mode: 'emulator' } }), () => { throw Error('PRIVATE'); }]) {
    const res = response(); await createLookupMaintenance({ select })({ method: 'POST', body: { dryRun: true } }, res);
    assert.equal(res.code, 503); assert(!JSON.stringify(res.body).includes('PRIVATE'));
  }
});
