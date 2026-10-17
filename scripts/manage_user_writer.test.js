'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseArgs, main, safeStatus } = require('./manage_user_writer.cjs');
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: 'a'.repeat(32), GCLOUD_PROJECT: 'demo-user-migration',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-migration-default-rtdb', FIRESTORE_EMULATOR_HOST: 'emulators:8080', FIREBASE_STORAGE_EMULATOR_HOST: 'emulators:9199', FIREBASE_AUTH_EMULATOR_HOST: 'emulators:9099' };
test('관리 도구는 대상·apply·epoch와 writer 종료 확인을 명시적으로 요구한다', () => {
  assert.equal(parseArgs(['status', '--writer-emulator']).command, 'status');
  for (const args of [['status'], ['status', '--writer-emulator', '--writer-production'], ['status', '--writer-emulator', '--apply'],
    ['activate', '--writer-emulator', '--apply', '--backend', 'legacy', '--epoch', '1'], ['copy', '--writer-emulator', '--apply'],
    ['recover', '--writer-emulator', '--operation', 'bad'], ['fence', '--writer-production', '--apply', '--operation', 'a'.repeat(32)]]) assert.throws(() => parseArgs(args));
});
test('원본 쓰기 재개는 backend/epoch·작업 ID·명시 적용/종료 확인을 함께 요구한다', () => {
  const args = ['resume', '--writer-emulator', '--backend', 'legacy', '--epoch', '7', '--operation', 'c'.repeat(32)];
  assert.equal(parseArgs(args).apply, false);
  assert.throws(() => parseArgs([...args, '--apply']));
  assert.throws(() => parseArgs(args.slice(0, -2)));
  const value = parseArgs([...args, '--apply', '--writers-drained']); assert.equal(value.command, 'resume'); assert.equal(value.epoch, 7);
});
test('재개 CLI는 기존 전환에 요청 ID와 종료 확인을 전달하며 응답 원문을 노출하지 않는다', async () => {
  const calls = [], out = [], args = ['resume', '--writer-emulator', '--backend', 'legacy', '--epoch', '1', '--operation', 'c'.repeat(32)];
  const runtime = { getProfileWriterBinding: () => ({ transition: { runId: env.USER_PROFILE_WRITER_RUN_ID,
    resume: async (...values) => calls.push(values),
    inspect: async () => ({ backend: 'legacy', epoch: 2, phase: 'accepting', unresolved: 0, externalUnresolved: 0, captured: 3, replayed: 2, copying: true, lastResume: '비공개 내부 상태' }) } }),
    closeProfileWriterRuntime: async () => calls.push('close') };
  assert.equal(await main(args, { env, createRuntime: () => assert.fail('미적용 연결 금지'), stdout: v => out.push(v) }), 0);
  assert.equal(await main([...args, '--apply', '--writers-drained'], { env, createRuntime: () => runtime, stdout: v => out.push(v) }), 0);
  assert.deepEqual(calls, [[{ backend: 'legacy', epoch: 1 }, { id: 'c'.repeat(32), writersDrained: true }], 'close']);
  assert.equal(JSON.parse(out[1]).epoch, 2); assert.doesNotMatch(out[1], /lastResume|비공개/);
});
test('준비 작업 취소 CLI도 개별 ID·epoch·명시 적용/종료 확인을 요구한다', async () => {
  const args = ['cancel-prepared', '--writer-emulator', '--backend', 'legacy', '--epoch', '1', '--operation', 'd'.repeat(32)], calls = [], out = [];
  assert.throws(() => parseArgs([...args, '--apply']));
  const runtime = { getProfileWriterBinding: () => ({ transition: { runId: env.USER_PROFILE_WRITER_RUN_ID,
    cancelPrepared: async (...values) => calls.push(values), inspect: async () => ({ backend: 'legacy', epoch: 1, phase: 'draining', unresolved: 0, externalUnresolved: 0, captured: 0, replayed: 0, copying: false }) } }), closeProfileWriterRuntime: async () => {} };
  assert.equal(await main([...args, '--apply', '--writers-drained'], { env, createRuntime: () => runtime, stdout: value => out.push(value) }), 0);
  assert.deepEqual(calls, [[{ backend: 'legacy', epoch: 1 }, 'd'.repeat(32)]]); assert.equal(JSON.parse(out[0]).unresolved, 0);
});
test('조회/미적용/등록되지 않은 운영 대상은 원문이나 실제 SDK를 열지 않는다', async () => {
  const out = [], err = []; let opened = 0;
  const dependencies = { env, createRuntime: () => { opened++; assert.fail('연결 금지'); }, stdout: s => out.push(s), stderr: s => err.push(s) };
  assert.equal(await main(['initialize', '--writer-emulator'], dependencies), 0); assert.equal(opened, 0); assert.deepEqual(JSON.parse(out[0]), { applied: false });
  assert.equal(await main(['status', '--writer-production'], dependencies), 1); assert.equal(opened, 0);
  const status = { backend: 'legacy', epoch: 1, phase: 'accepting', unresolved: 0, externalUnresolved: 0, captured: 0, replayed: 0, copying: false, userData: 'synthetic-private' };
  assert.equal(JSON.stringify(safeStatus(status)).includes('synthetic-private'), false);
});
test('지정 epoch로만 변경하고 업무 결과는 출력하지 않으며 성공/실패 모두 연결을 닫는다', async () => {
  for (const failed of [false, true]) {
    const calls = [], output = [], errors = [];
    const runtime = { getProfileWriterBinding: () => ({ transition: { runId: env.USER_PROFILE_WRITER_RUN_ID,
      drain: async writer => { calls.push(writer); if (failed) throw Object.assign(Error('synthetic-secret'), { code: 'WRITER_FENCED' }); },
      inspect: async () => ({ backend: 'legacy', epoch: 1, phase: 'draining', unresolved: 0, externalUnresolved: 0, captured: 0, replayed: 0, copying: false }) } }),
      closeProfileWriterRuntime: async () => calls.push('close') };
    const result = await main(['drain', '--writer-emulator', '--apply', '--backend', 'legacy', '--epoch', '1'], { env, createRuntime: () => runtime, stdout: s => output.push(s), stderr: s => errors.push(s) });
    assert.equal(result, failed ? 1 : 0); assert.deepEqual(calls, [{ backend: 'legacy', epoch: 1 }, 'close']);
    assert.doesNotMatch(JSON.stringify([output, errors]), /synthetic-secret/);
  }
});
test('종료 실패는 성공 보고를 내보내지 않고 안전한 코드만 반환한다', async () => {
  const out = [], err = [], runtime = { getProfileWriterBinding: () => ({ transition: { runId: env.USER_PROFILE_WRITER_RUN_ID,
    inspect: async () => ({ backend: 'legacy', epoch: 1, phase: 'accepting', unresolved: 0, externalUnresolved: 0, captured: 0, replayed: 0, copying: false }) } }),
    closeProfileWriterRuntime: async () => { throw Error('synthetic-private'); } };
  assert.equal(await main(['status', '--writer-emulator'], { env, createRuntime: () => runtime, stdout: s => out.push(s), stderr: s => err.push(s) }), 1);
  assert.equal(out.length, 0); assert.deepEqual(JSON.parse(err[0]), { code: 'USER_STORAGE_CLOSE_FAILED' });
});

test('계획 정리는 cutoff·작업 ID·배치 상한·명시 적용/종료 확인을 요구한다', () => {
  const base = ['plan-cleanup', '--writer-emulator', '--backend', 'legacy', '--epoch', '3', '--before-epoch', '3', '--operation', 'b'.repeat(32)];
  assert.equal(parseArgs(base).beforeEpoch, 3); assert.equal(parseArgs(base).limit, 32);
  for (const extra of [['--apply'], ['--limit', '33'], ['--limit', '0']]) assert.throws(() => parseArgs([...base, ...extra]));
  assert.throws(() => parseArgs(base.map(value => value === '3' ? '0' : value)));
  assert.equal(parseArgs([...base, '--apply', '--writers-drained']).apply, true);
});
test('계획 정리 미리보기/적용은 분리되며 출력에서 사용자 원문을 제거한다', async () => {
  for (const apply of [false, true]) {
    const out = [], calls = [], runtime = { getProfileWriterBinding: () => ({ transition: { runId: env.USER_PROFILE_WRITER_RUN_ID,
      previewPlanCleanup: async () => { calls.push('preview'); return { selected: 1, scanned: 3, retained: 2, hasMore: false, original: 'synthetic-private' }; },
      cleanupPlans: async () => { calls.push('apply'); return { selected: 1, removed: 1, scanned: 3, retained: 2, hasMore: false, original: 'synthetic-private' }; },
    } }), closeProfileWriterRuntime: async () => calls.push('close') };
    const args = ['plan-cleanup', '--writer-emulator', '--backend', 'legacy', '--epoch', '3', '--before-epoch', '3', '--operation', 'b'.repeat(32), ...(apply ? ['--apply', '--writers-drained'] : [])];
    assert.equal(await main(args, { env, createRuntime: () => runtime, stdout: value => out.push(value), stderr: () => assert.fail('오류 없음') }), 0);
    assert.deepEqual(calls, [apply ? 'apply' : 'preview', 'close']); assert.doesNotMatch(out[0], /synthetic-private/); assert.equal(JSON.parse(out[0]).applied, apply);
  }
});
