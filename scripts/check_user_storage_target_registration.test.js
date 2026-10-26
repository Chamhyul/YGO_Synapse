'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('./check_user_storage_target_registration.cjs');
const fixture = () => ({ projectId: 'synthetic-project', targets: [{ id: 'user-data', projectId: 'synthetic-project',
  instanceId: 'synthetic-project-default-rtdb', location: 'asia-southeast1',
  databaseURL: 'https://synthetic-project-default-rtdb.asia-southeast1.firebasedatabase.app/', writerRunId: 'a'.repeat(32) }] });

test('고정 운영 대상 검사는 입력을 변경하지 않고 비밀값·프로젝트 값을 출력하지 않는다', () => {
  const input = fixture(), before = structuredClone(input);
  assert.deepEqual(validate(input), { targets: 1, valid: true });
  assert.deepEqual(input, before);
});
test('빈 준비용 등록·중복 대상은 배포 전에 차단한다', () => {
  for (const targets of [[], null, [...fixture().targets, ...fixture().targets]]) {
    assert.throws(() => validate({ ...fixture(), targets }));
  }
});
test('다른 프로젝트·DB·리전·URL 인증정보·잘못된 전환 ID를 거부한다', () => {
  for (const patch of [{ projectId: 'another-project' }, { instanceId: 'other-database' },
    { location: 'asia-northeast3' }, { databaseURL: 'https://user:pass@example.invalid/' },
    { writerRunId: '' }, { writerRunId: 'INVALID' }, { unexpected: true }]) {
    const input = fixture(); Object.assign(input.targets[0], patch);
    assert.throws(() => validate(input));
  }
});
