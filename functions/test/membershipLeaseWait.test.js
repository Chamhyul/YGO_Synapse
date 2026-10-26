'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMembershipWriterRepository } = require('../services/userMembershipWriterRepository');
const failure = code => Object.assign(new Error('synthetic'), { code });
function fixture({ begin = async () => {}, end = async () => {}, timeoutMs = 1000 } = {}) {
  const scope = new AsyncLocalStorage(), calls = { begin: [], end: 0, sessions: 0 };
  const writer = { backend: 'rtdb', epoch: 4, phase: 'accepting' };
  const repository = createMembershipWriterRepository({ initialize: async () => writer, initializeMissing: false,
    profiles: {}, adapters: { rtdb: { withVerificationSession: action => action() } }, timeoutMs,
    transition: {
      async beginExternal(...args) { calls.begin.push({ args, scope: scope.getStore() }); return begin(...args); },
      async endExternal(id) { calls.end++; return end(id); },
      withSession(action) { return scope.run(++calls.sessions, action); },
    } });
  return { repository, calls, writer };
}
for (const provider of ['discord', 'youtube']) test(`${provider} 최초 잠금 경합만 기다리고 매번 새 세션으로 한 번 실행한다`, async () => {
  let attempts = 0, actions = 0;
  const f = fixture({ begin: async () => { if (++attempts < 3) throw failure('WRITER_RESOURCE_BUSY'); } });
  assert.equal(await f.repository.withVerification('synthetic', provider, async () => { actions++; return 'saved'; }), 'saved');
  assert.equal(actions, 1); assert.equal(f.calls.end, 1); assert.equal(f.calls.sessions, 3);
  assert.equal(new Set(f.calls.begin.map(x => x.args[1])).size, 1);
  assert.deepEqual(f.calls.begin.map(x => x.scope), [1, 2, 3]);
  assert(f.calls.begin.every(x => x.args[0] === f.writer));
});
test('지속되는 잠금 경합은 제한 시간에 끝나고 업무·종료·강제 잠금 해제를 하지 않는다', async () => {
  const error = failure('WRITER_RESOURCE_BUSY'), f = fixture({ begin: async () => { throw error; }, timeoutMs: 30 });
  const before = Date.now(), warn = console.warn, lines = []; console.warn = value => lines.push(value);
  try { await assert.rejects(f.repository.withVerification('synthetic', 'discord', () => assert.fail('업무 실행 금지')), actual => actual === error); }
  finally { console.warn = warn; }
  assert(Date.now() - before >= 25); assert(Date.now() - before < 1000);
  assert.equal(f.calls.end, 0); assert.equal(lines.length, 1);
});
for (const code of ['WRITER_FENCED', 'WRITER_DRAINING', 'USER_STORAGE_WRITE_AMBIGUOUS', 'USER_STORAGE_CONFLICT', 'USER_STORAGE_READ_TIMEOUT']) {
  test(`${code}는 잠금 경합으로 취급하거나 재제출하지 않는다`, async () => {
    const error = failure(code), f = fixture({ begin: async () => { throw error; } }), warn = console.warn; console.warn = () => {};
    try { await assert.rejects(f.repository.withVerification('synthetic', 'discord', () => assert.fail('업무 실행 금지')), actual => actual === error); }
    finally { console.warn = warn; }
    assert.equal(f.calls.begin.length, 1); assert.equal(f.calls.end, 0);
  });
}
test('기다리는 동안 drain되면 기존 writer로 거부하며 새 epoch로 갈아타지 않는다', async () => {
  let n = 0; const error = failure('WRITER_DRAINING'), f = fixture({ begin: async () => { throw ++n === 1 ? failure('WRITER_RESOURCE_BUSY') : error; } });
  const warn = console.warn; console.warn = () => {};
  try { await assert.rejects(f.repository.withVerification('synthetic', 'discord', () => assert.fail('업무 실행 금지')), actual => actual === error); }
  finally { console.warn = warn; }
  assert.equal(f.calls.begin.length, 2); assert.equal(f.calls.end, 0);
});
test('잠금 확보 후 업무의 BUSY나 종료 ACK 유실은 인증 전체를 재실행하지 않는다', async () => {
  for (const stage of ['action', 'end']) {
    const error = failure(stage === 'action' ? 'WRITER_RESOURCE_BUSY' : 'USER_STORAGE_WRITE_AMBIGUOUS');
    let actions = 0; const f = fixture({ end: async () => { if (stage === 'end') throw error; } });
    await assert.rejects(f.repository.withVerification('synthetic', 'discord', async () => { actions++; if (stage === 'action') throw error; }), actual => actual === error);
    assert.equal(actions, 1); assert.equal(f.calls.begin.length, 1); assert.equal(f.calls.end, 1);
  }
});
