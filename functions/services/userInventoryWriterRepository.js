'use strict';
const { measure } = require('./inventoryRequestTiming');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { createInventoryWriterAdapters, checkInventoryKey, clearedManifest, splitStable, emptyInventory, verifyInventoryBlob } = require('./userInventoryWriterAdapters');
const { createProfileWriterAdapters, checkProfileKey, profileReceiptMatches, reserveProfileChange } = require('./userProfileWriterAdapters');
const { createProfileWriterBinding } = require('./userProfileWriterRepository');
const { createUserWriterTransition } = require('./userWriterTransition');
const { createWriterJournalStore } = require('./user-storage/writerJournalStore');
const { createPartitionedInventoryStore } = require('./user-storage/partitionedInventoryStore');
const { retokenApiSummary } = require('./user-storage/inventoryApiSummary');
const { createRtdbInventoryRepository } = require('./inventoryRepository');
const { hydrateInventory } = require('./user-storage/inventoryManifest');
const { content, fingerprint } = require('./userMigrationRehearsal');
const fail = code => Object.assign(new Error('인벤토리 저장 경계가 변경되었습니다. 원본 상태를 확인해 주세요.'), { code });
const { createMembershipWriterAdapters, checkVerificationKey, checkMembershipCommand } = require('./userMembershipWriterAdapters');
const { createMembershipWriterRepository } = require('./userMembershipWriterRepository');
const { createSessionWriterAdapters, checkSessionKey, checkSessionCommand } = require('./adminSessionWriterAdapters');
const { createSessionWriterRepository } = require('./adminSessionWriterRepository');
const { checkAccountResource } = require('./user-storage/accountResource');
const { createApiWriterAdapters, checkApiKey, checkApiCommand } = require('./cardApiWriterAdapters');
const { createApiWriterRepository } = require('./cardApiWriterRepository');
const { createCsvWriterAdapters } = require('./membershipCsvWriterAdapters');
const { createCsvWriterRepository } = require('./membershipCsvWriterRepository');
const { checkCsvKey, checkCsvCommand } = require('./membershipCsvWriterContract');
const { createAdminWriterRequests, checkAdminResource } = require('./adminWriterRequests');
// 공지 정제기·Storage SDK는 멤버십 worker의 claims 처리에 필요하지 않다.
const createNoticeWriterService = options => require('./noticeWriterService').createNoticeWriterService(options);
const { deferredWriterService, deferredWriterAdapters } = require('./deferredWriterService');
const { createWriterHistoryStore } = require('./user-storage/writerHistoryStore');
const { createWriterPlanStore } = require('./user-storage/writerPlanStore');
const isAdminResource = key => key.startsWith('adminRequest/') || key.startsWith('notice/');
const isCsv = key => key.startsWith('csv/');
const checkCsvRequest = key => { if (!/^csvRequest\/[a-f0-9]{32}$/.test(key)) throw fail('CSV_WRITER_INVALID_KEY'); };
const isApi = key => key.startsWith('apiKey/');
const checkApiResource = key => { if (key !== 'apiCors/current' && !/^apiRequest\/[a-f0-9]{32}$/.test(key)) throw fail('API_WRITER_INVALID_KEY'); };
const isSession = key => key.startsWith('session/');
const checkRequestKey = key => { if (!/^sessionRequest\/[a-f0-9]{32}$/.test(key)) throw fail('SESSION_WRITER_INVALID_KEY'); };
const isVerification = key => key.startsWith('verification/');
const isInventory = key => key.startsWith('inventory/');
const keyFor = uid => { if (typeof uid !== 'string') throw fail('INVENTORY_WRITER_INVALID_KEY'); const key = `inventory/${uid}`; checkInventoryKey(key); return key; };
function createUserInventoryWriterBinding({ db, database, bucket, FieldValue, runId, migration, deferOptionalServices = false,
  config, historyMaintenance = 'inline', sessionNow = Date.now, apiClock = Date.now, csvNow = Date.now, noticeNow = Date.now, noticeStorage, timeoutMs = 10000, onAmbiguousWrite, onCheckpoint, initializeMissing = true, now = () => new Date().toISOString() } = {}) {
  if (typeof migration?.prepareInventoryV2 !== 'function' || typeof migration?.inventoryMigrationStatus !== 'function') throw fail('USER_STORAGE_INVALID_CONFIG');
  const service = (create, passiveLease = false) => deferOptionalServices ? deferredWriterService(create, { passiveLease }) : create();
  const adapters = create => deferOptionalServices ? deferredWriterAdapters(create) : create();
  const inventories = createInventoryWriterAdapters({ db, FieldValue, database, bucket, timeoutMs, onAmbiguousWrite });
  const profiles = createProfileWriterAdapters({ db, database, FieldValue, timeoutMs, onAmbiguousWrite });
  const history = createWriterHistoryStore({ database, runId, timeoutMs, onAmbiguousWrite });
  const membershipAdapters = createMembershipWriterAdapters({ db, database, FieldValue, profiles, history, timeoutMs, onAmbiguousWrite });
  const sessionAdapters = adapters(() => createSessionWriterAdapters({ db, database, timeoutMs, onAmbiguousWrite, now: sessionNow }));
  const apiAdapters = adapters(() => createApiWriterAdapters({ db, database, timeoutMs, onAmbiguousWrite, now: apiClock }));
  const csvAdapters = adapters(() => createCsvWriterAdapters({ db, database, timeoutMs, onAmbiguousWrite, now: csvNow }));
  let adminRequests;
  const stores = Object.fromEntries(['legacy', 'rtdb'].map(backend => {
    const dispatch = key => isCsv(key) ? csvAdapters[backend] : isApi(key) ? apiAdapters[backend] : isSession(key) ? sessionAdapters[backend] : isInventory(key) ? inventories[backend] : isVerification(key) ? membershipAdapters[backend] : profiles[backend];
    const source = require('./user-storage/writerSnapshotSource').createWriterSnapshotSource({ db, database, bucket, backend,
      adapters: { profile: profiles[backend], inventory: inventories[backend], membership: membershipAdapters[backend], session: sessionAdapters[backend], api: apiAdapters[backend], csv: csvAdapters[backend] },
      timeoutMs, onAmbiguousWrite, audit: () => adminRequests.auditLegacyLocks() });
    return [backend, {
      read: key => dispatch(key).read(key),
      snapshotPage: source.page,
      snapshotLayout: source.layout,
      snapshot: async () => { await adminRequests.auditLegacyLocks(); return [...await profiles[backend].snapshot(), ...await inventories[backend].snapshot(), ...await membershipAdapters[backend].snapshot(), ...await sessionAdapters[backend].snapshot(), ...await apiAdapters[backend].snapshot(), ...await csvAdapters[backend].snapshot()].sort((a, b) => a.key.localeCompare(b.key)); },
      commit: (op, onConfirmedReceipt) => (op.details?.kind === 'membership' ? membershipAdapters[backend] : dispatch(op.changes[0].key)).commit(op, onConfirmedReceipt), receipt: op => (op.details?.kind === 'membership' ? membershipAdapters[backend] : dispatch(op.changes[0].key)).receipt(op),
      fence: op => (op.details?.kind === 'membership' ? membershipAdapters[backend] : dispatch(op.changes[0].key)).fence(op), cancellationReason: op => (op.details?.kind === 'membership' ? membershipAdapters[backend] : dispatch(op.changes[0].key)).cancellationReason(op),
      apply: (id, entry, expected) => dispatch(entry.key).apply(id, entry, expected),
      ...(backend === 'rtdb' ? { archiveConfirmedReceipts: membershipAdapters[backend].archiveConfirmedReceipts } : {}),
    }];
  }));
  const journal = createWriterJournalStore({ database, path: 'profileWriterTransitions', maxAttempts: 10, timeoutMs, onAmbiguousWrite });
  const plans = createWriterPlanStore({ database, runId, timeoutMs, onAmbiguousWrite });
  const transition = createUserWriterTransition({ journal, history, plans, runId, stores, onCheckpoint, historyMaintenance,
    checkKey: key => isAdminResource(key) ? checkAdminResource(key) : isCsv(key) ? checkCsvKey(key) : key.startsWith('csvRequest/') ? checkCsvRequest(key) : isApi(key) ? checkApiKey(key) : key.startsWith('apiCors/') || key.startsWith('apiRequest/') ? checkApiResource(key) : key.startsWith('account/') ? checkAccountResource(key) : isSession(key) ? checkSessionKey(key) : key.startsWith('sessionRequest/') ? checkRequestKey(key) : isInventory(key) ? checkInventoryKey(key) : isVerification(key) ? checkVerificationKey(key) : checkProfileKey(key),
    checkCommand: (_, changes, details) => { if (details?.kind === 'membershipCsv') { checkCsvCommand({ changes, details }); return; } if (details?.kind === 'apiAccess') { checkApiCommand({ changes, details }); return; } if (details?.kind === 'session') { checkSessionCommand({ changes, details }); return; } if (details?.kind === 'membership') { checkMembershipCommand({ changes, details }); return; } if (changes.some(entry => isAdminResource(entry.key) || isCsv(entry.key) || entry.key.startsWith('csvRequest/') || isApi(entry.key) || entry.key.startsWith('apiCors/') || entry.key.startsWith('apiRequest/') || isVerification(entry.key) || isSession(entry.key) || entry.key.startsWith('account/') || entry.key.startsWith('sessionRequest/'))) throw fail('INVENTORY_WRITER_INVALID_COMMAND'); if (!(changes.length === 1 || changes.length === 2 && changes.some(entry => isVerification(entry.key)) && changes.some(entry => entry.key.startsWith('fs/users/')))) throw fail('INVENTORY_WRITER_INVALID_COMMAND'); },
    receiptMatches: (op, actual, planned) => op.details?.kind === 'profile' ? profileReceiptMatches(op, actual, planned) : content(actual) === content(planned),
    reserveChange: (op, entry) => op.details?.kind === 'profile' ? reserveProfileChange(op, entry) : entry,
  });
  const profile = createProfileWriterBinding({ db, database, FieldValue, runId, timeoutMs, onAmbiguousWrite,
    sharedTransition: transition, sharedStores: stores, registrationResources: uid => [keyFor(uid)], initializeMissing,
    inventoryExists: async (backend, uid) => { keyFor(uid); return inventories[backend].exists(uid); },
  });
  const initialize = profile.initialize;
  const membership = createMembershipWriterRepository({ transition, adapters: membershipAdapters, profiles, initialize, initializeMissing, timeoutMs });
  const adminSessions = service(() => createSessionWriterRepository({ transition, adapters: sessionAdapters, initialize, initializeMissing, timeoutMs }), true);
  adminRequests = service(() => createAdminWriterRequests({ transition, initialize, initializeMissing, db, database, timeoutMs }), true);
  const notices = service(() => createNoticeWriterService({ requests: adminRequests, transition, bucket, ...(noticeStorage ? { storage: noticeStorage } : {}), timeoutMs, now: noticeNow,
    parentLease: () => adminRequests.writerLease() || adminSessions.writerLease(),
    environment: config?.mode === 'emulator' ? 'local' : 'production' }));
  const membershipCsv = service(() => createCsvWriterRepository({ transition, adapters: csvAdapters, initialize, initializeMissing, now: csvNow, timeoutMs,
    parentLease: () => membership.writerLease() || adminSessions.writerLease() || adminRequests.writerLease() }));
  const apiAccess = service(() => createApiWriterRepository({ transition, adapters: apiAdapters, initialize, initializeMissing, timeoutMs, clock: apiClock }));
  const customClaims = require('./userClaimsWriterStore').createClaimsWriterStore({ transition, initialize, initializeMissing, database, timeoutMs, onAmbiguousWrite, writerLease: () => membership.writerLease() || adminSessions.writerLease() || adminRequests.writerLease() });
  const claimsStorage = { membership, membershipCsv, customClaims, config, writerTransition: transition };
  const requestWriter = new AsyncLocalStorage();
  const imports = require('./inventoryImportRequests').createInventoryImportRequests({ transition });
  function publish(writer, uid, current, value, blobs = []) {
    return measure('inventory.publish', () => transition.withSession(() => publishInSession(writer, uid, current, value, blobs)));
  }
  async function publishInSession(writer, uid, current, value, blobs = []) {
    const importAttempt = imports.current(uid);
    const key = keyFor(uid), id = importAttempt?.operationId || randomBytes(16).toString('hex');
    const result = importAttempt ? importAttempt.result() : null;
    const changes = [{ key, exists: true, token: current.token, value }];
    const options = { resources: [`fs/users/${uid}`], details: { kind: 'inventory', ...(importAttempt ? { importDigest: importAttempt.digest } : {}), blobs: blobs.map(({ hash, token, value: body }) => ({ hash, token, value: body })) } };
    let operation; const deadline = Date.now() + timeoutMs;
    if (writer.backend === 'rtdb') {
      while (true) {
        try {
          const completed = await transition.prepareAndExecuteWithReceipt(writer, id, changes, result,
            { ...options, onPrepared: op => { operation = op; } });
          return measure('writer.receipt_final', () => completed.receipt.changes[0]);
        } catch (error) {
          if (error.code === 'WRITER_RESOURCE_BUSY' && !operation && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20)); continue;
          }
          if (error.code === 'WRITER_CANCELLED' && operation
              && await inventories.rtdb.cancellationReason(operation) === 'conflict') throw fail('USER_STORAGE_CONFLICT');
          throw error;
        }
      }
    }
    while (!operation) {
      try { operation = await transition.prepare(writer, id, changes, result, options); }
      catch (error) { if (error.code !== 'WRITER_RESOURCE_BUSY' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    let completed;
    try { completed = await transition.executeWithReceipt(writer, id); }
    catch (error) {
      if (error.code === 'WRITER_CANCELLED' && await inventories[writer.backend].cancellationReason(operation) === 'conflict') throw fail('USER_STORAGE_CONFLICT');
      throw error;
    }
    // 완료 journal CAS까지 성공한 같은 실행의 검증 영수증을 전달한다. DB를 재조회하지 않는다.
    return measure('writer.receipt_final', () => completed.receipt.changes[0]);
  }
  const rtdbStore = createPartitionedInventoryStore({ database, timeoutMs, onAmbiguousWrite, now, verifyBlob: verifyInventoryBlob,
    publisher: async ({ uid, current, candidate, kind }) => {
      const writer = requestWriter.getStore();
      if (writer?.backend !== 'rtdb') throw fail('WRITER_FENCED');
      for (const blob of candidate.blobs) blob.token = fingerprint(blob.value).slice(0, 32);
      if (candidate.manifest) retokenApiSummary(candidate.manifest, candidate.blobs);
      const value = { exists: kind !== 'clear', manifest: kind === 'clear' ? clearedManifest(current.value) : candidate.manifest };
      const entry = await publish(writer, uid, { token: current.revision ? `${current.revision}:${current.generation}` : '0' }, value, candidate.blobs);
      const [revision, generation] = entry.token.split(':').map(Number);
      return { head: { exists: value.exists, revision, generation, value: value.manifest }, cleanupPending: true };
    },
  });
  const rtdbRepository = createRtdbInventoryRepository({ storage: { inventory: rtdbStore }, migration });
  async function legacyData(state, uid) {
    const record = state.entry;
    if (!record.exists || !record.value.exists) return emptyInventory();
    // 아직 writer head가 없는 원본은 inspect에서 본문과 manifest를 함께 검증했다.
    // 카드마다 같은 원본을 다시 다운로드·분할하지 않고 그 호출의 snapshot을 사용한다.
    if (state.sourceInventory) return state.sourceInventory;
    const blobs = {};
    for (const [hash, ref] of Object.entries(record.value.manifest.cards || {})) if (hash.startsWith('h')) blobs[hash] = await inventories.legacy.blob(uid, hash, ref.v);
    return hydrateInventory(record.value.manifest, blobs, { uid }).inventory;
  }
  async function route() {
    const initialized = await initialize();
    // 운영 초기화는 매번 현재 route를 읽는다. 에뮬레이터의 초기화 promise는
    // 캐시될 수 있으므로 그 경우에만 전환 뒤의 backend/epoch를 다시 읽는다.
    return initializeMissing ? transition.route() : initialized;
  }
  const inventoryRepository = {
    readInventoryForSync: require('./inventoryConditionalSync').createInventorySyncReader({
      route, metadata: uid => rtdbStore.readMetadata(uid, { forSync: true }),
      snapshot: (uid, writer) => requestWriter.run(writer, () => rtdbRepository.readInventorySnapshot(uid)),
      migrationStatus: migration.inventoryMigrationStatus,
    }),
    importStatus: imports.status,
    withImportAttempt: imports.run,
    async downloadInventory(uid) {
      const writer = await route();
      if (writer.backend === 'rtdb') return rtdbRepository.downloadInventory(uid);
      const state = await inventories.legacy.inspect(keyFor(uid));
      return { data: await legacyData(state, uid), generation: state.entry.token };
    },
    async updateInventoryWithRetry(uid, mutate, maxRetries = 3, options = {}) {
      if (typeof mutate !== 'function' || !Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > 10) throw fail('USER_STORAGE_INVALID_UPDATE');
      const attempt = imports.current(uid);
      if (attempt) {
        if (typeof options.importResult !== 'function') throw fail('IMPORT_REQUEST_INVALID');
        attempt.result = options.importResult;
        maxRetries = 1; // 확정 취소 후에는 새로운 HTTP 시도로만 다시 계산한다.
      }
      const writer = await route();
      if (writer.backend === 'rtdb') return requestWriter.run(writer, () => rtdbRepository.updateInventoryWithRetry(uid, mutate, maxRetries, options));
      const memo = new Map(); let firstReset;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const state = await inventories.legacy.inspect(keyFor(uid)), record = state.entry;
        firstReset ??= state.reset;
        if (state.reset !== firstReset) throw fail('USER_STORAGE_CONFLICT');
        const inventory = await legacyData(state, uid), before = JSON.stringify(inventory);
        await migration.prepareInventoryV2(inventory, memo); await mutate(inventory);
        inventory.version = migration.inventoryMigrationStatus(inventory).status === 'complete' ? 3 : 1;
        if (before === JSON.stringify(inventory)) return inventory;
        inventory.updatedAt = now();
        const manifest = record.value?.manifest;
        const candidate = splitStable(inventory, manifest && { locationNames: manifest.header.locationNames || {}, nextLocationId: manifest.header.nextLocationId });
        try { await publish(writer, uid, record, { exists: true, manifest: candidate.manifest }, candidate.blobs); return inventory; }
        catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT' || attempt + 1 === maxRetries) throw error; }
      }
    },
    async deleteInventory(uid) {
      const writer = await route();
      const current = await inventories[writer.backend].read(keyFor(uid));
      await publish(writer, uid, current, { exists: false, manifest: clearedManifest(current.value?.manifest) });
    },
  };
  async function archiveMembershipReceipts({ cursor, limit = 16, apply = false } = {}) {
    const batch = await history.page('operations', { cursor, limit });
    const result = await membershipAdapters.rtdb.archiveConfirmedReceipts(batch.items.map(item => item.value), { apply });
    return { scanned: batch.items.length, ...result, cursor: batch.cursor };
  }
  const maintainMembershipReceipts = require('./membershipReceiptMaintenance').createMembershipReceiptMaintenance({
    database, runId, archivePage: archiveMembershipReceipts, timeoutMs, onAmbiguousWrite });
  return { repository: profile.repository, inventoryRepository, transition, stores, inventories, membership, membershipAdapters, claimsStorage, adminSessions, sessionAdapters, apiAccess, apiAdapters, membershipCsv, csvAdapters, adminRequests, notices, initialize, archiveMembershipReceipts, maintainMembershipReceipts };
}
module.exports = { createUserInventoryWriterBinding };
