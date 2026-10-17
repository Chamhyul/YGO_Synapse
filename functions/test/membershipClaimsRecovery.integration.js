'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { createEmulatorUserStorage } = require('../services/user-storage');
const { resolveRtdbConfig } = require('../config/userStorage');
const { syncMembershipClaims, inspectMembershipClaims, recoverMembershipClaims, membershipClaim, updateAccountClaims } = require('../services/membershipClaims');
resolveRtdbConfig();
// 이 검사 파일의 독립 프로세스에만 Auth 시험 주소를 설정한다. 운영 API·자격증명은 사용하지 않는다.
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'emulators:9099';
const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT,
  credential: { getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }) } }, 'synthetic-claims-recovery-auth');
const auth = getAuth(app), stores = [createEmulatorUserStorage(), createEmulatorUserStorage()];
after(async () => { await Promise.all(stores.map(store => store.close())); await deleteApp(app); });
const deps = (storage = stores[0], selectedAuth = auth) => ({ storage, auth: selectedAuth, env: process.env, allowEmulator: true });
const source = { status: 'active', type: 'discord', levelName: '합성 회원', discordId: '123456789012345678', verificationVersion: 2, verificationProvider: 'discord' };
let sequence = 0;
async function setup(state = 'uncertain') {
  const uid = `synthetic-claims-recovery-${++sequence}`;
  await auth.createUser({ uid }); await auth.setCustomUserClaims(uid, { role: 'admin', admin: true, separate: { preserve: 1 } });
  await stores[0].profile.createIfAbsent(uid, { settings: { theme: 'dark', membership: source } });
  const operationId = await stores[0].customClaims.acquire(uid);
  if (state === 'uncertain') await stores[0].customClaims.finish(uid, operationId, true);
  return { uid, operationId };
}
function cli(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../scripts/reconcile_membership_claims.cjs'), ...args], { env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('합성 CLI 시간초과')); }, 20000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
test('실제 RTDB/Auth 대조는 DB·계정·잠금을 변경하지 않는다', async () => {
  const { uid } = await setup(); const before = await stores[0].customClaims.inspect(uid);
  const claims = (await auth.getUser(uid)).customClaims, profile = await stores[0].profile.read(uid);
  const result = await inspectMembershipClaims(uid, deps()); assert.equal(result.matches, false); assert.equal(result.stable, true);
  assert.deepEqual(await stores[1].customClaims.inspect(uid), before); assert.deepEqual((await auth.getUser(uid)).customClaims, claims);
  assert.deepEqual(await stores[1].profile.read(uid), profile);
});
test('독립 연결의 동시 복구는 하나만 잠금을 인계하며 늦은 이전 finish를 거부한다', async () => {
  const { uid, operationId } = await setup('running');
  const attempts = await Promise.allSettled(stores.map(store => store.customClaims.beginRecovery(uid, operationId, { writersDrained: true })));
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(value => value.status === 'rejected').reason.code, 'MEMBERSHIP_CLAIMS_RECOVERY_CONFLICT');
  await assert.rejects(stores[0].customClaims.finish(uid, operationId), { code: 'MEMBERSHIP_CLAIMS_BUSY' });
  assert.equal((await syncMembershipClaims(uid, deps())).status, 'pending');
  assert.equal((await stores[0].customClaims.inspect(uid)).state, 'running');
});
test('이전 작업 종료 확인 없이는 일치한 Auth 값도 잠금을 해제하지 않는다', async () => {
  const { uid, operationId } = await setup();
  await auth.setCustomUserClaims(uid, { ...(await auth.getUser(uid)).customClaims, ygoMembership: membershipClaim(await stores[0].membership.read(uid)) });
  assert.equal((await inspectMembershipClaims(uid, deps())).matches, true);
  await assert.rejects(recoverMembershipClaims(uid, operationId, deps()), { code: 'MEMBERSHIP_CLAIMS_RECOVERY_CONFIRMATION_REQUIRED' });
  assert.equal((await stores[0].customClaims.inspect(uid)).operationId, operationId);
});
test('SDK 복구는 현재 관리자/별도claims와 프로필을 보존하고 다음 권한 변경을 허용한다', async () => {
  const { uid, operationId } = await setup(); await auth.updateUser(uid, { disabled: true });
  const before = await stores[0].profile.read(uid);
  const result = await recoverMembershipClaims(uid, operationId, { ...deps(), writersDrained: true });
  assert.equal(result.status, 'synced'); assert.equal((await stores[1].customClaims.inspect(uid)).state, 'idle');
  const claims = (await auth.getUser(uid)).customClaims; assert.equal(claims.role, 'admin'); assert.equal(claims.admin, true);
  assert.deepEqual(claims.separate, { preserve: 1 }); assert.equal(claims.ygoMembership.active, true);
  assert.deepEqual(await stores[0].profile.read(uid), before);
  await updateAccountClaims(uid, { role: 'none', admin: false }, deps(stores[1]));
  assert.equal((await auth.getUser(uid)).customClaims.admin, false);
  await assert.rejects(recoverMembershipClaims(uid, operationId, { ...deps(), writersDrained: true }), { code: 'MEMBERSHIP_CLAIMS_RECOVERY_CONFLICT' });
});
test('실패 복구의 새 작업 번호로 재대조·재복구하며 원문 오류를 저장하지 않는다', async () => {
  const { uid, operationId } = await setup();
  const failedAuth = { getUser: actual => auth.getUser(actual), setCustomUserClaims: async () => { throw new Error('synthetic-private-error'); } };
  await assert.rejects(recoverMembershipClaims(uid, operationId, { ...deps(stores[0], failedAuth), writersDrained: true }));
  const lock = await stores[1].customClaims.inspect(uid); assert.equal(lock.state, 'uncertain'); assert.notEqual(lock.operationId, operationId);
  assert.doesNotMatch(JSON.stringify(lock), /private|token|claims/);
  await recoverMembershipClaims(uid, lock.operationId, { ...deps(stores[1]), writersDrained: true });
  assert.equal((await inspectMembershipClaims(uid, deps())).matches, true);
});
test('별도 CLI 프로세스는 읽기 대조 후 명시 복구하고 개인 정보 없이 상태만 출력한다', async () => {
  const { uid, operationId } = await setup(), before = await stores[0].customClaims.inspect(uid);
  const read = await cli(['--uid', uid]); assert.equal(read.code, 0, read.stderr);
  assert.deepEqual(await stores[0].customClaims.inspect(uid), before); assert.equal(JSON.parse(read.stdout).recovered, false);
  const recovered = await cli(['--uid', uid, '--operation', operationId, '--recover', '--writers-drained']);
  assert.equal(recovered.code, 0, recovered.stderr); const result = JSON.parse(recovered.stdout);
  assert.equal(result.matches, true); assert.equal(result.state, 'idle'); assert.equal(result.recovered, true);
  assert.doesNotMatch(recovered.stdout, /synthetic-claims|discordId|levelName|role|separate|token/);
  const stale = await cli(['--uid', uid, '--operation', operationId, '--recover', '--writers-drained']);
  assert.equal(stale.code, 1); assert.equal(JSON.parse(stale.stderr).code, 'MEMBERSHIP_CLAIMS_RECOVERY_CONFLICT');
});
test('CLI 운영 주소·미확인 복구는 SDK 생성 전에 거부한다', async () => {
  const { uid, operationId } = await setup(), before = await stores[0].customClaims.inspect(uid);
  const denied = await cli(['--uid', uid, '--operation', operationId, '--recover']); assert.equal(denied.code, 2);
  const operational = await cli(['--uid', uid], { ...process.env, USER_DATABASE_URL: 'https://production.invalid/' });
  assert.equal(operational.code, 1); assert.equal(JSON.parse(operational.stderr).code, 'USER_STORAGE_CONFIG_INVALID');
  assert.deepEqual(await stores[0].customClaims.inspect(uid), before);
});
