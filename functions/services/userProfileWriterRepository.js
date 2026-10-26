'use strict';
const { measure } = require('./inventoryRequestTiming');
const { randomBytes } = require('node:crypto');
const { createWriterJournalStore } = require('./user-storage/writerJournalStore');
const { createWriterHistoryStore } = require('./user-storage/writerHistoryStore');
const { createWriterPlanStore } = require('./user-storage/writerPlanStore');
const { mergeProfile, validateProfilePatch } = require('./user-storage/profileStore');
const { serverTimestampPaths } = require('./user-storage/profileCodec');
const { createUserWriterTransition } = require('./userWriterTransition');
const { createProfileWriterAdapters, checkProfileKey, profileReceiptMatches, reserveProfileChange } = require('./userProfileWriterAdapters');
const { encodeValue, decodeValue } = require('./user-storage/codec');
const { takeInitialWriterRoute } = require('./initialWriterRoute');
const fail = code => Object.assign(new Error('프로필 writer가 변경되었습니다. 저장 상태를 확인한 뒤 다시 요청해 주세요.'), { code });
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const clone = value => decodeValue(encodeValue(value));

function createProfileWriterBinding({ db, database, FieldValue, runId, inventoryExists, timeoutMs = 10000,
  onAmbiguousWrite, onCheckpoint, now = Date.now, maxAttempts = 3, journal: suppliedJournal, history: suppliedHistory, plans: suppliedPlans,
  sharedTransition, sharedStores, registrationResources = () => [], initializeMissing = true } = {}) {
  if (typeof inventoryExists !== 'function' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10
      || typeof now !== 'function') throw fail('PROFILE_WRITER_INVALID_DEPENDENCIES');
  const stores = sharedStores || createProfileWriterAdapters({ db, database, FieldValue, timeoutMs, onAmbiguousWrite });
  if (!sharedStores) for (const backend of ['legacy', 'rtdb']) {
    const source = require('./user-storage/writerSnapshotSource').createWriterSnapshotSource({ db, database, backend,
      adapters: { profile: stores[backend] }, timeoutMs, onAmbiguousWrite });
    stores[backend].snapshotPage = source.page; stores[backend].snapshotLayout = source.layout;
  }
  const journal = suppliedJournal || createWriterJournalStore({ database, path: 'profileWriterTransitions', maxAttempts: 10, timeoutMs, onAmbiguousWrite });
  const history = sharedTransition ? undefined : suppliedHistory || (!suppliedJournal ? createWriterHistoryStore({ database, runId, timeoutMs, onAmbiguousWrite }) : undefined);
  const plans = sharedTransition ? undefined : suppliedPlans || (!suppliedJournal ? createWriterPlanStore({ database, runId, timeoutMs, onAmbiguousWrite }) : undefined);
  const transition = sharedTransition || createUserWriterTransition({ journal, history, plans, stores, runId, checkKey: checkProfileKey,
    receiptMatches: profileReceiptMatches, reserveChange: reserveProfileChange, onCheckpoint });
  let ready;
  const initialize = () => initializeMissing ? ready ||= transition.route().catch(error => { if (error.code !== 'WRITER_NOT_INITIALIZED') throw error; return transition.initialize(); })
    : Promise.resolve(takeInitialWriterRoute(transition) || transition.route());
  const keyFor = uid => { if (typeof uid !== 'string') throw fail('PROFILE_WRITER_INVALID_KEY'); const key = `fs/users/${uid}`; checkProfileKey(key); return key; };
  async function stableRead(uid, checkInventory = false) {
    const initialized = await measure('registration.route_before', initialize), key = keyFor(uid);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 운영 initialize는 fresh route다. 첫 시도만 재사용하고 재시도·최종
      // epoch 확인은 다시 읽어 전환 중 snapshot을 반환하지 않는다.
      const route = attempt === 0 && !initializeMissing ? initialized : await transition.route();
      const record = await measure('registration.profile_read', () => stores[route.backend].read(key));
      if (record.exists && !plain(record.value)) throw fail('USER_STORAGE_INVALID_PROFILE_PATCH');
      const registered = checkInventory && (record.exists || await inventoryExists(route.backend, uid));
      const after = await measure('registration.route_after', () => transition.route());
      if (route.backend === after.backend && route.epoch === after.epoch) {
        if (checkInventory && (await measure('registration.profile_recheck', () => stores[route.backend].read(key))).token !== record.token) continue;
        return { record, registered };
      }
    }
    throw fail('WRITER_FENCED');
  }
  async function mutate(uid, patch, paths = [], onlyAbsent = false) {
    if (!plain(patch)) throw fail('USER_STORAGE_INVALID_PROFILE_PATCH');
    validateProfilePatch(patch); const stable = clone(patch); serverTimestampPaths(stable, paths);
    const initialized = await initialize(), key = keyFor(uid);
    const writer = initializeMissing ? await transition.route() : initialized;
    const deadline = Date.now() + timeoutMs; let conflicts = 0;
    while (Date.now() < deadline) {
      const current = await stores[writer.backend].read(key);
      if (current.exists && !plain(current.value)) throw fail('USER_STORAGE_INVALID_PROFILE_PATCH');
      if (onlyAbsent && (current.exists || await inventoryExists(writer.backend, uid))) return;
      const final = mergeProfile(current.value, stable), id = randomBytes(16).toString('hex'); let operation;
      const options = { details: { kind: 'profile', serverTimestampPaths: paths }, resources: [key, ...registrationResources(uid)] };
      try {
        const changes = [{ key, exists: true, token: current.token, value: final }];
        // 가입 생성은 잠금 뒤 인벤토리 부재 재검사가 필요하므로 기존 두 단계를 유지한다.
        if (!onlyAbsent && typeof transition.prepareAndExecuteWithReceipt === 'function') {
          await transition.prepareAndExecuteWithReceipt(writer, id, changes, null,
            { ...options, onPrepared: value => { operation = value; } });
          return;
        }
        operation = await transition.prepare(writer, id, changes, null, options);
        // 인벤토리 writer와 같은 UID 자원을 확보한 뒤 가입 의존성을 다시 확인한다.
        if (onlyAbsent && await inventoryExists(writer.backend, uid)) { await transition.cancelPrepared(writer, id); return; }
        await transition.execute(writer, id); return;
      }
      catch (error) {
        if (error.code === 'WRITER_RESOURCE_BUSY' && !operation) {
          await new Promise(resolve => setTimeout(resolve, 20)); continue;
        }
        // 업무 transaction의 영구 취소 receipt가 있는 CAS 충돌만 새 원본으로 재시도한다.
        if (error.code !== 'WRITER_CANCELLED' || !operation
            || await stores[writer.backend].cancellationReason(operation) !== 'conflict'
            || ++conflicts >= maxAttempts) throw error;
      }
    }
    throw fail('USER_STORAGE_QUEUE_TIMEOUT');
  }
  const repository = {
    async read(uid) { const { record } = await stableRead(uid); return { exists: record.exists, value: record.exists ? record.value : undefined }; },
    async isRegistered(uid) { return (await stableRead(uid, true)).registered; },
    // 가입 판정의 전후 route·프로필 token 검사를 통과한 같은 snapshot이다.
    // 로그인 진입점에서 즉시 소비하며 다음 요청이나 claims의 재검사에 사용하지 않는다.
    async readRegistrationProfile(uid) {
      const { record, registered } = await stableRead(uid, true);
      return { registered, profile: { exists: record.exists, value: record.exists ? record.value : undefined } };
    },
    async completeRegistration(uid, versions) {
      await mutate(uid, { createdAt: null, registration: { completed: true, consent: {
        terms: versions.terms, privacy: versions.privacy, acceptedAt: null,
      } } }, [['createdAt'], ['registration', 'consent', 'acceptedAt']], true);
    },
    async updateSettings(uid, settings) { await mutate(uid, { settings: { ...settings, updatedAt: now() } }); },
    async updateNickname(uid, nickname) { await mutate(uid, { Nickname: nickname, updatedAt: null }, [['updatedAt']]); },
  };
  return { repository, transition, stores, initialize };
}
module.exports = { createProfileWriterBinding };
