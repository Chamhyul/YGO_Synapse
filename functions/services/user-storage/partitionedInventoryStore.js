'use strict';

const { measure } = require('../inventoryRequestTiming');
const { isDeepStrictEqual } = require('node:util');
const { encodeKey, encodeValue, decodeValue } = require('./codec');
const { buildApiSummary, readApiSummary, patchApiSummary, migrationStatus, readSyncMigration, canReuseSyncMigration } = require('./inventoryApiSummary');
const { createRecordStore, DEFAULT_MAX_ATTEMPTS } = require('./recordStore');
const { createInventoryOperations } = require('./inventoryOperations');
const { createStorageAccess, validateStoragePath, DEFAULT_TIMEOUT_MS } = require('./storageAccess');
const { inventoryPayloadCodec } = require('./inventoryCodec');
const { manifestPayloadCodec, cardHash, cardBlobPath, splitInventory, hydrateInventory,
  readSelected, patchInventory } = require('./inventoryManifest');

const fail = (code, message) => Object.assign(new Error(message), { code });
const conflict = () => fail('USER_STORAGE_CONFLICT', '조회 중 인벤토리가 변경되었습니다. 다시 조회해 주세요.');
const clone = value => decodeValue(encodeValue(value));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function selectedNumbers(numbers, allowEmpty = true) {
  if (!Array.isArray(numbers) || numbers.length > 1000 || (!allowEmpty && !numbers.length)
      || numbers.some(number => typeof number !== 'string') || Object.keys(numbers).length !== numbers.length) {
    throw fail('USER_STORAGE_INVALID_UPDATE', '조회하거나 수정할 카드 번호 목록이 올바르지 않습니다.');
  }
  return [...new Set(numbers)];
}

// demo API용 시험 어댑터. head의 CAS만 공개 시점을 결정한다.
// 카드 버전은 매 시도 새 주소에 기록하고, 퇴역한 주소는 절대로 다시 참조하지 않는다.
function createPartitionedInventoryStore({ database, path = 'inventories', partsPath = 'inventoryCardVersions',
  operationsPath = 'inventoryOperations',
  prepare = async () => {}, prepareCards = async () => {}, now = () => new Date().toISOString(), readSnapshots,
  maxAttempts = DEFAULT_MAX_ATTEMPTS, timeoutMs, onAmbiguousWrite, publisher, verifyBlob } = {}) {
  if (verifyBlob !== undefined && typeof verifyBlob !== 'function') throw fail('USER_STORAGE_INVALID_CONFIG', '카드 버전 검증 함수가 올바르지 않습니다.');
  if (publisher !== undefined && typeof publisher !== 'function') throw fail('USER_STORAGE_INVALID_CONFIG', '인벤토리 공개 어댑터가 올바르지 않습니다.');
  if (typeof prepare !== 'function' || typeof prepareCards !== 'function' || typeof now !== 'function') {
    throw fail('USER_STORAGE_INVALID_CONFIG', '인벤토리 준비 함수가 올바르지 않습니다.');
  }
  path = validateStoragePath(path);
  partsPath = validateStoragePath(partsPath);
  operationsPath = validateStoragePath(operationsPath);
  const roots = [path, partsPath, operationsPath];
  if (roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex
      && (root === other || root.startsWith(`${other}/`))))) {
    throw fail('USER_STORAGE_INVALID_CONFIG', '인벤토리 제어 경로와 카드 내용 경로는 겹칠 수 없습니다.');
  }
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const operations = createInventoryOperations({ database, path: operationsPath, partsPath, timeoutMs, onAmbiguousWrite });
  const empty = () => ({ version: 3, updatedAt: now(), amount: 0, locations: {}, rarities: {}, cards: {} });
  const cleared = state => {
    const nextLocationId = state?.legacy?.locationState?.nextLocationId ?? state?.header?.nextLocationId ?? 1;
    const header = inventoryPayloadCodec.encode({ inventory: empty(), locationState: { locationNames: {}, nextLocationId } });
    delete header.cards;
    return { type: 'inventory-parts', version: 1, header, cards: { count: 0 } };
  };
  const headStore = createRecordStore({ database, path, maxAttempts, timeoutMs, onAmbiguousWrite,
    payloadCodec: manifestPayloadCodec, retainOnDelete: cleared, archiveReceipt: operations.archive });
  // 실제 ID를 사용하는 각 접근에서도 설정과 전체 경로 길이를 검사한다.
  cardBlobPath('config-check', cardHash('config-check'), '0'.repeat(32), { partsPath });
  const root = uid => `${path}/${encodeKey(uid)}`;
  const context = uid => ({ basePath: `${root(uid)}/payload`, uid, partsPath });
  const initialGenerationFor = options => {
    const generation = options?.expectedGeneration;
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) {
      throw fail('USER_STORAGE_INVALID_GENERATION', '기대하는 초기화 세대가 올바르지 않습니다.');
    }
    return generation;
  };
  const fullRequired = generation => Object.assign(fail('USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE',
    '전체 인벤토리 준비 후 다시 처리해야 합니다.'), { generation });
  const attemptsFor = options => {
    const count = options?.maxAttempts ?? maxAttempts;
    if (!Number.isSafeInteger(count) || count < 1 || count > 10) {
      throw fail('USER_STORAGE_INVALID_UPDATE', '변경 재시도 횟수가 올바르지 않습니다.');
    }
    return count;
  };
  const refs = manifest => Object.entries(manifest?.cards || {}).filter(([key]) => key.startsWith('h'));
  const entries = (uid, manifest) => refs(manifest).map(([hash, ref]) =>
    ({ hash, token: ref.v, path: cardBlobPath(uid, hash, ref.v, { partsPath }) }));
  const finalBlobs = (candidate, previous) => {
    const next = { ...previous };
    for (const blob of candidate.blobs) next[blob.hash] = blob.value;
    for (const hash of Object.keys(next)) if (!Object.prototype.hasOwnProperty.call(candidate.manifest.cards || {}, hash)) delete next[hash];
    return next;
  };
  const assertScope = (cards, numbers) => {
    if (!plain(cards) || Reflect.ownKeys(cards).some(key => typeof key !== 'string' || !numbers.includes(key))) {
      throw fail('USER_STORAGE_INVALID_UPDATE', '지정한 카드 범위 밖의 변경은 저장할 수 없습니다.');
    }
  };

  async function getBlobs(uid, manifest, numbers) {
    const wanted = numbers ? new Set(numbers.map(cardHash)) : undefined;
    const loaded = {};
    // 큰 전체 읽기에서도 SDK에 무제한 동시 요청을 만들지 않는다.
    const targets = entries(uid, manifest).filter(entry => !wanted || wanted.has(entry.hash));
    let cursor = 0, failed = false, failure;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(16, targets.length) }, async () => {
      while (!failed && cursor < targets.length) {
        const entry = targets[cursor++];
        try {
          const value = await access.read(entry.path);
          if (value === null || value === undefined) {
            throw fail('USER_STORAGE_MISSING_CARD_VERSION', '현재 인벤토리가 참조하는 카드 내용이 없습니다. 원본을 보존합니다.');
          }
          if (verifyBlob) verifyBlob(value, entry.token);
          loaded[entry.hash] = value;
        } catch (error) { if (!failed) { failed = true; failure = error; } throw error; }
      }
    }));
    if (failed) throw failure;
    const rejected = workers.find(worker => worker.status === 'rejected');
    if (rejected) throw rejected.reason;
    return loaded;
  }

  async function snapshot(uid, numbers, { useReadSnapshot = false, preparedOnly = false, viewOnly = false, beforeFinalRead } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 쓰기·복구는 원본만 사용한다. 조회용 복사본은 현재 head와 본문 지문을
      // 매번 대조하며, 실패/누락이면 같은 head의 원본 읽기로 돌아간다.
      const [headRead, viewRead] = await Promise.allSettled([
        headStore.read(uid), useReadSnapshot ? readSnapshots?.load(uid) : undefined,
      ]);
      if (headRead.status === 'rejected') throw headRead.reason;
      const head = headRead.value;
      if (!head.exists) {
        if (beforeFinalRead) {
          if (!await beforeFinalRead()) return { unauthorized: true };
          // 부재/삭제도 계정 검사를 기다리는 동안 생성·복구될 수 있다.
          const after = await headStore.read(uid);
          if (head.revision !== after.revision || head.generation !== after.generation || after.exists) continue;
        }
        return { head, state: { inventory: empty(), locationState: {
          locationNames: {}, nextLocationId: head.value?.header?.nextLocationId ?? head.value?.legacy?.locationState?.nextLocationId ?? 1,
        } }, blobs: {}, cards: {} };
      }
      if (preparedOnly) {
        const summary = !head.value.legacy && head.value.header?.inventoryVersion === 3
          ? readApiSummary(head.value, context(uid)) : undefined;
        if (!summary || !canReuseSyncMigration(summary.migration, Date.now())) return { head, needsPreparation: true };
      }
      if (head.value.legacy) {
        if (numbers) throw Object.assign(fail('USER_STORAGE_PARTIAL_REQUIRES_UPGRADE', '기존 저장 형식은 전체 갱신을 통해 전환한 뒤 부분 조회·수정할 수 있습니다.'), { generation: head.generation });
        return { head, state: head.value.legacy, blobs: {} };
      }
      let blobs, state, cards, error, requested;
      try {
        if (useReadSnapshot && readSnapshots && viewRead.status === 'fulfilled') {
          try { blobs = readSnapshots.unpack(uid, head, viewRead.value); } catch (_) { /* 검증 실패는 원본 읽기 */ }
        }
        if (!blobs && viewOnly) return { head, viewMissing: true };
        if (!blobs) {
          if (useReadSnapshot && readSnapshots) requested = Promise.resolve()
            .then(() => readSnapshots.request(uid, head, viewRead.status === 'fulfilled' ? viewRead.value : undefined)).catch(() => {});
          blobs = await getBlobs(uid, head.value, numbers);
        }
        if (numbers) cards = readSelected(head.value, blobs, { ...context(uid), numbers }).cards;
        else state = hydrateInventory(head.value, blobs, context(uid));
      } catch (caught) { error = caught; }
      finally { await requested; }
      // 선행 읽기는 현재 계정 검사가 성공한 뒤 최종 revision을 확인한다.
      if (beforeFinalRead && !await beforeFinalRead()) return { unauthorized: true };
      // 성공 commit 뒤의 이전 버전 정리와 경합한 독자는 최신 head에서 다시 읽는다.
      const afterRevision = await access.read(`${root(uid)}/revision`);
      if (head.revision !== afterRevision) continue;
      if (error) throw error;
      return { head, state, blobs, cards };
    }
    throw conflict();
  }

  async function requireParts(uid) {
    const type = await access.read(`${root(uid)}/payload/type`);
    if (type !== null && type !== 'inventory-parts') {
      throw fail('USER_STORAGE_PARTIAL_REQUIRES_UPGRADE', '기존 저장 형식은 전체 갱신 후 부분 조회·수정할 수 있습니다.');
    }
    if (type === null && await access.read(`${root(uid)}/payload/version`) !== null) {
      throw fail('USER_STORAGE_PARTIAL_REQUIRES_UPGRADE', '범용 저장 형식은 전체 갱신 후 부분 조회·수정할 수 있습니다.');
    }
  }

  async function readPaths(paths) {
    const values = [];
    for (let start = 0; start < paths.length; start += 16) {
      values.push(...await Promise.all(paths.slice(start, start + 16).map(target => access.read(target))));
    }
    return values;
  }

  // 선택 조회에서는 전체 참조 목록까지 내려받지 않는다. 작은 메타데이터와
  // 요청 참조/위치 이름/본문을 읽고 마지막 revision으로 서로 같은 시점인지 확인한다.
  async function selectedSnapshot(uid, numbers) {
    const base = root(uid);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const metadata = await api.readMetadata(uid);
      if (!metadata.exists) return cardRecord(metadata, {});
      if (metadata.storageFormat !== 'parts') {
        throw fail('USER_STORAGE_PARTIAL_REQUIRES_UPGRADE', '기존 저장 형식은 전체 갱신 후 부분 조회·수정할 수 있습니다.');
      }
      let cards, error;
      try {
        const hashes = numbers.map(cardHash);
        const [nextLocationId, inventoryVersion, nullPrototype, headerType, headerVersion, ...selectedRefs] = await readPaths([
          `${base}/payload/header/nextLocationId`, `${base}/payload/header/inventoryVersion`,
          `${base}/payload/cards/nullPrototype`, `${base}/payload/header/type`, `${base}/payload/header/version`,
          ...hashes.map(hash => `${base}/payload/cards/${hash}`),
        ]);
        if (headerType !== 'inventory' || headerVersion !== 1) {
          throw fail('user-storage/invalid-inventory-format', '지원하지 않는 인벤토리 헤더 형식입니다.');
        }
        if (!Number.isSafeInteger(nextLocationId) || nextLocationId < 1
            || (nullPrototype !== null && nullPrototype !== true)) {
          throw fail('USER_STORAGE_INVALID_RECORD', '위치 ID 또는 카드 목록 원형 표시가 올바르지 않습니다.');
        }
        const order = new Set(), locations = new Set();
        const collection = { count: 0 };
        if (nullPrototype === true) collection.nullPrototype = true;
        for (let index = 0; index < hashes.length; index++) {
          const ref = selectedRefs[index];
          if (ref === null) continue;
          if (!plain(ref) || !Number.isSafeInteger(ref.o) || ref.o < 0
              || metadata.cardCount === undefined || ref.o >= metadata.cardCount || order.has(ref.o)
              || (ref.l !== undefined && !plain(ref.l))) {
            throw fail('USER_STORAGE_INVALID_RECORD', '선택 카드의 참조 메타데이터가 올바르지 않습니다.');
          }
          order.add(ref.o);
          for (const id of Object.keys(ref.l || {})) {
            if (!/^l[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id.slice(1)))
                || Number(id.slice(1)) >= nextLocationId || ref.l[id] !== true) {
              throw fail('USER_STORAGE_INVALID_RECORD', '위치 참조 키가 올바르지 않습니다.');
            }
            locations.add(id);
          }
          collection[hashes[index]] = { ...ref };
          collection.count++;
        }
        refs({ cards: collection }).sort((a, b) => a[1].o - b[1].o)
          .forEach(([, ref], index) => { ref.o = index; });
        const locationIds = [...locations];
        const names = await readPaths(locationIds.map(id => `${base}/payload/header/locationNames/${id}`));
        const header = { type: headerType, version: headerVersion, nextLocationId };
        if (inventoryVersion !== null) header.inventoryVersion = inventoryVersion;
        if (locationIds.length) header.locationNames = Object.fromEntries(locationIds.map((id, index) => [id, names[index]]));
        const subset = { type: 'inventory-parts', version: 1, header, cards: collection };
        // 본문을 요청하기 전에 버전 토큰/위치 ID 등 경로에 쓰는 값을 검사한다.
        manifestPayloadCodec.decode(subset, context(uid));
        const blobs = await getBlobs(uid, subset, numbers);
        cards = readSelected(subset, blobs, { ...context(uid), numbers }).cards;
      } catch (caught) { error = caught; }
      if (await access.read(`${base}/revision`) !== metadata.revision) continue;
      if (error) throw error;
      return cardRecord(metadata, cards);
    }
    throw conflict();
  }

  const fullRecord = (head, state) => ({ ...head, value: head.exists ? state.inventory : empty() });
  const cardRecord = (head, cards) => ({ exists: head.exists, revision: head.revision,
    generation: head.generation, value: cards, scope: 'cards' });

  async function cleanup(targets, closeOperationId) {
    if (!targets.length) return false;
    let pending = false, cursor = 0, expired = false, timer;
    const work = Promise.all(Array.from({ length: Math.min(8, targets.length) }, async () => {
      while (!expired && cursor < targets.length) {
        const entry = targets[cursor++];
        try {
          if (closeOperationId) await operations.closeStage(entry, closeOperationId);
          else await access.removeUnreferenced(entry.path);
        }
        catch (error) {
          pending = true;
          if (error?.code === 'USER_STORAGE_WRITE_AMBIGUOUS') { expired = true; break; }
        }
      }
    })).then(() => pending || cursor < targets.length);
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { expired = true; resolve(true); }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
  }

  const report = (id, operation) => ({ operationId: id, status: operation.state,
    cleanup: operation.cleanup, expectedRevision: operation.plan.expectedRevision,
    ...(operation.receipt ? { revision: operation.receipt.revision, generation: operation.receipt.generation } : {}) });

  async function operationSnapshot(uid, id) {
    // head를 관측한 뒤 저널을 다시 읽는다. 후속 writer가 먼저 보관한 성공
    // 증거를 오래된 pending 스냅샷으로 덮거나 실패로 오판하지 않는다.
    await operations.read(uid, id);
    const head = await headStore.read(uid);
    let operation = await operations.read(uid, id);
    if (head.commitReceipt?.id === id) {
      operation = operations.confirmed(uid, id, operation, head.commitReceipt);
    }
    return { head, operation };
  }

  async function recoverOperation(uid, id, { cancelPending = false } = {}) {
    if (typeof cancelPending !== 'boolean') throw fail('USER_STORAGE_INVALID_OPERATION', '복구 취소 옵션이 올바르지 않습니다.');
    let current, cancelledHere = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      current = await operationSnapshot(uid, id);
      if (['committed', 'cancelled'].includes(current.operation.state)) break;
      if (!cancelPending) return report(id, current.operation);
      if (current.head.revision < current.operation.plan.expectedRevision) {
        throw fail('USER_STORAGE_INVALID_OPERATION', '작업 기록보다 이전의 인벤토리입니다. 자동 복구하지 않습니다.');
      }
      try {
        const head = await headStore.fence(uid, current.head.revision,
          { operationId: id, operationDigest: current.operation.digest });
        current = { head, operation: operations.confirmed(uid, id, current.operation, head.commitReceipt) };
        cancelledHere = true;
        break;
      } catch (error) {
        if (error.code !== 'USER_STORAGE_CONFLICT' || attempt + 1 === maxAttempts) throw error;
      }
    }
    // terminal 상태를 먼저 영속화하여 늦은 ready가 정리 방식을 바꾸지 못하게 한다.
    const operation = await operations.archive(uid, current.operation.receipt);
    if (operation.cleanup !== 'pending') return { ...report(id, operation), cancelledHere };
    const targets = operations.paths(uid, operation, operation.state === 'committed' ? 'retired' : 'staged');
    const head = await headStore.read(uid);
    if (targets.some(entry => head.value?.cards?.[entry.hash]?.v === entry.token)) {
      throw fail('USER_STORAGE_INVALID_OPERATION', '현재 참조하는 카드 버전은 복구 정리할 수 없습니다.');
    }
    const fenced = operation.state === 'cancelled' && !operation.ready && targets.length > 0;
    const pending = await cleanup(targets, fenced ? id : undefined);
    let completed = operation;
    if (!pending) {
      try { completed = await operations.finish(uid, id, fenced ? 'fenced' : 'complete'); }
      catch { /* 본문 변경 성공/취소는 이미 확정됐다. 정리 상태만 다음 대조에서 확인한다. */ }
    }
    return { ...report(id, completed), cancelledHere };
  }

  async function publish(uid, current, candidate, retired, kind = 'update') {
    // 전환 writer는 기존 계획/선택 카드 읽기를 사용하며 자체 원자적 receipt로 공개한다.
    if (publisher) return publisher({ uid, current, candidate, retired, kind,
      clearManifest: kind === 'clear' ? cleared(current.value) : undefined });
    const operationId = operations.newId();
    const plan = { expectedRevision: current.revision, generation: current.generation, kind };
    if (candidate.blobs.length) plan.staged = Object.fromEntries(candidate.blobs.map(blob => [blob.hash, blob.token]));
    if (retired.length) plan.retired = Object.fromEntries(retired.map(entry => [entry.hash, entry.token]));
    let head, created = false;
    try {
      const operation = await operations.create(uid, operationId, plan);
      created = true;
      for (const blob of candidate.blobs) await operations.stage(blob);
      await operations.ready(uid, operationId);
      const commit = { operationId, operationDigest: operation.digest };
      head = kind === 'clear' ? await headStore.delete(uid, current.revision, commit)
        : await headStore.compareAndSet(uid, current.revision, candidate.manifest, commit);
    } catch (error) {
      error.operationId = operationId;
      error.cleanupPending = true;
      if (created && error.code !== 'USER_STORAGE_WRITE_AMBIGUOUS') {
        try {
          const recovered = await recoverOperation(uid, operationId, { cancelPending: true });
          if (recovered.status === 'committed') {
            // SDK의 명시적 실패도 예외 경로에서 결과를 추측해 업무를 재실행하지 않는다.
            error.code = 'USER_STORAGE_WRITE_AMBIGUOUS';
          } else {
            if (recovered.cleanup !== 'pending') delete error.cleanupPending;
            if (!recovered.cancelledHere) error.code = 'USER_STORAGE_OPERATION_CANCELLED';
          }
        } catch { /* 결과 대조가 실패하면 후보와 작업 기록을 보존한다. */ }
      }
      throw error;
    }
    // 결과 보관/정리는 확정된 수량 변경을 실패나 재실행으로 바꾸지 않는다.
    let cleanupPending = true;
    try { cleanupPending = (await recoverOperation(uid, operationId)).cleanup === 'pending'; } catch {}
    return { head, operationId, cleanupPending };
  }

  async function update(uid, mutate, options) {
    if (typeof mutate !== 'function') throw fail('USER_STORAGE_INVALID_UPDATE', '인벤토리 변경 함수가 필요합니다.');
    const attempts = attemptsFor(options);
    let initialGeneration = initialGenerationFor(options);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = await snapshot(uid);
      if (initialGeneration === undefined) initialGeneration = current.head.generation;
      if (current.head.generation !== initialGeneration) throw conflict();
      const metadata = { exists: current.head.exists, revision: current.head.revision,
        generation: current.head.generation, attempt };
      const before = options?.skipUnchanged ? clone(current.state.inventory) : undefined;
      await prepare(current.state.inventory, metadata);
      const result = await mutate(current.state.inventory, metadata);
      if (options?.skipUnchanged && isDeepStrictEqual(before, current.state.inventory)
          && (!current.head.exists || current.head.value?.apiSummary
            || (current.head.value?.type === 'inventory-parts'
              && !buildApiSummary(current.head.value, current.state.inventory, context(uid))))) {
        return { record: fullRecord(current.head, current.state), result };
      }
      current.state.inventory.updatedAt = now();
      const candidate = splitInventory(current.state, context(uid));
      // 전체 호환 갱신도 내용이 같은 카드는 기존 불변 버전을 계속 참조한다.
      candidate.blobs = candidate.blobs.filter(blob => {
        const previous = current.head.value?.cards?.[blob.hash];
        if (!previous || !isDeepStrictEqual(current.blobs[blob.hash], blob.value)) return true;
        candidate.manifest.cards[blob.hash].v = previous.v;
        return false;
      });
      const apiSummary = buildApiSummary(candidate.manifest, current.state.inventory, context(uid));
      if (apiSummary) candidate.manifest.apiSummary = apiSummary;
      else delete candidate.manifest.apiSummary;
      const retired = entries(uid, current.head.value).filter(entry => candidate.manifest.cards?.[entry.hash]?.v !== entry.token);
      const restored = hydrateInventory(candidate.manifest, finalBlobs(candidate, current.blobs), context(uid));
      try {
        const saved = await publish(uid, current.head, candidate, retired);
        return { record: fullRecord(saved.head, restored), result, operationId: saved.operationId,
          ...(saved.cleanupPending ? { cleanupPending: true } : {}) };
      } catch (error) {
        if (error.code !== 'USER_STORAGE_CONFLICT' || error.cleanupPending || attempt + 1 === attempts) throw error;
      }
    }
  }

  async function updateCards(uid, inputNumbers, mutate, options) {
    const numbers = selectedNumbers(inputNumbers, false);
    if (typeof mutate !== 'function') throw fail('USER_STORAGE_INVALID_UPDATE', '카드 변경 함수가 필요합니다.');
    await requireParts(uid);
    const attempts = attemptsFor(options);
    let initialGeneration = initialGenerationFor(options);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = await measure('inventory.snapshot', () => snapshot(uid, numbers));
      if (initialGeneration === undefined) initialGeneration = current.head.generation;
      if (current.head.generation !== initialGeneration) throw conflict();
      const manifest = current.head.value || cleared();
      if (!manifest.cards || manifest.header.inventoryVersion !== 3
          || Object.prototype.hasOwnProperty.call(manifest.header, 'summaryCompatibility')) {
        throw fail('USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE', '과거 형식이나 호환 집계가 있는 인벤토리는 전체 갱신이 필요합니다.');
      }
      const metadata = { exists: current.head.exists, revision: current.head.revision,
        generation: current.head.generation, attempt };
      const cards = current.cards;
      await prepareCards(cards, metadata);
      assertScope(cards, numbers);
      const result = await mutate(cards, metadata);
      assertScope(cards, numbers);
      const candidate = patchInventory(manifest, cards, current.blobs, { ...context(uid), numbers, updatedAt: now() });
      const restored = readSelected(candidate.manifest, finalBlobs(candidate, current.blobs), { ...context(uid), numbers }).cards;
      try {
        const saved = await publish(uid, current.head, candidate, candidate.retired);
        return { record: cardRecord(saved.head, restored), result, operationId: saved.operationId,
          ...(saved.cleanupPending ? { cleanupPending: true } : {}) };
      } catch (error) {
        if (error.code !== 'USER_STORAGE_CONFLICT' || error.cleanupPending || attempt + 1 === attempts) throw error;
      }
    }
  }

  // 기존 업무 mutator에 선택 카드와 전체 응답 집계를 함께 제공한다. 준비가 필요한
  // 과거 자료는 callback을 실행하기 전에 전체 경로로 넘긴다.
  async function updateApiCards(uid, inputNumbers, mutate, options) {
    const numbers = selectedNumbers(inputNumbers);
    if (typeof mutate !== 'function') throw fail('USER_STORAGE_INVALID_UPDATE', '카드 변경 함수가 필요합니다.');
    const attempts = attemptsFor(options);
    let initialGeneration = initialGenerationFor(options);
    for (let attempt = 0; attempt < attempts; attempt++) {
      let current;
      try { current = await measure('inventory.snapshot', () => snapshot(uid, numbers)); }
      catch (error) {
        if (error.code === 'USER_STORAGE_PARTIAL_REQUIRES_UPGRADE') {
          if (initialGeneration !== undefined && error.generation !== initialGeneration) throw conflict();
          throw fullRequired(error.generation);
        }
        throw error;
      }
      if (initialGeneration === undefined) initialGeneration = current.head.generation;
      if (current.head.generation !== initialGeneration) throw conflict();
      const manifest = current.head.value || cleared();
      let summary = readApiSummary(manifest, context(uid));
      if (!current.head.exists) {
        summary = { amount: 0, locations: {}, rarities: {}, migration: {
          pendingCount: 0, unresolvedCount: 0, nextRetryAt: 0, retryAt: 0, retryableError: false } };
      }
      if (!summary || manifest.header.inventoryVersion !== 3 || !manifest.cards
          || migrationStatus(summary).status !== 'complete') throw fullRequired(initialGeneration);
      const header = { ...manifest.header };
      delete header.locationNames;
      const draft = inventoryPayloadCodec.decode(header, context(uid)).inventory;
      Object.assign(draft, { amount: summary.amount, locations: clone(summary.locations), rarities: clone(summary.rarities), cards: current.cards });
      const before = clone(draft);
      const metadata = { exists: current.head.exists, revision: current.head.revision,
        generation: current.head.generation, attempt };
      const result = await mutate(draft, metadata);
      assertScope(draft.cards, numbers);
      const rootBefore = { ...before }, rootAfter = { ...draft };
      for (const key of ['cards', 'amount', 'locations', 'rarities']) { delete rootBefore[key]; delete rootAfter[key]; }
      if (!isDeepStrictEqual(rootBefore, rootAfter)) throw fail('USER_STORAGE_INVALID_UPDATE', '카드별 수정에서 인벤토리 루트 정보를 변경할 수 없습니다.');
      if (isDeepStrictEqual(before, draft)) return { record: { ...fullRecord(current.head, { inventory: draft }), scope: 'api-cards' },
        result, inventoryMigration: migrationStatus(summary) };
      // 전역 집계는 mutator가 유지한 순서와 rarity 0까지 그대로 보존한다.
      const candidate = patchInventory(manifest, draft.cards, current.blobs,
        { ...context(uid), numbers, apiSummary: true, updatedAt: now() });
      draft.updatedAt = candidate.manifest.header.updatedAt;
      const partialHeader = inventoryPayloadCodec.encode({ inventory: draft, locationState: {
        locationNames: candidate.manifest.header.locationNames || {}, nextLocationId: candidate.manifest.header.nextLocationId,
      } }, context(uid));
      if (Object.prototype.hasOwnProperty.call(partialHeader, 'summaryCompatibility')) {
        candidate.manifest.header.summaryCompatibility = partialHeader.summaryCompatibility;
      } else delete candidate.manifest.header.summaryCompatibility;
      candidate.manifest.apiSummary = patchApiSummary(candidate.manifest, before.cards, draft, summary, context(uid));
      const nextSummary = readApiSummary(candidate.manifest, context(uid));
      const status = migrationStatus(nextSummary);
      if (status.status !== 'complete') {
        draft.version = 1;
        candidate.manifest.header.inventoryVersion = 1;
        // 추가된 미처리 CID는 다음 요청에서 전체 준비가 실행되도록 요약을 제거한다.
        delete candidate.manifest.apiSummary;
      }
      manifestPayloadCodec.encode(candidate.manifest, context(uid));
      try {
        const saved = await publish(uid, current.head, candidate, candidate.retired);
        return { record: { ...fullRecord(saved.head, { inventory: draft }), scope: 'api-cards' }, result, operationId: saved.operationId,
          inventoryMigration: status, ...(saved.cleanupPending ? { cleanupPending: true } : {}) };
      } catch (error) {
        if (error.code !== 'USER_STORAGE_CONFLICT' || error.cleanupPending || attempt + 1 === attempts) throw error;
      }
    }
  }

  const api = {
    async read(uid) { const current = await snapshot(uid); return fullRecord(current.head, current.state); },
    async readPrepared(uid, { viewOnly = false, beforeFinalRead } = {}) {
      const current = await snapshot(uid, undefined, { useReadSnapshot: true, preparedOnly: true, viewOnly, beforeFinalRead });
      if (current.needsPreparation || current.viewMissing || current.unauthorized) return;
      if (!current.head.exists) return fullRecord(current.head, current.state);
      if (current.head.value.legacy || current.state.inventory.version !== 3) return;
      // hydrateInventory가 본문과 요약 전체를 대조한 같은 요청의 증거다.
      const summary = readApiSummary(current.head.value, context(uid));
      if (!summary || !canReuseSyncMigration(summary.migration, Date.now())) return;
      return fullRecord(current.head, current.state);
    },
    async captureReadSnapshot(uid) {
      // worker는 복사본을 재복사하거나 조회만으로 CID/원본을 수정하지 않는다.
      const current = await snapshot(uid, undefined, { preparedOnly: true });
      if (current.needsPreparation) return;
      if (!current.head.exists) return current.head.revision > 0 ? { head: current.head, blobs: {} } : undefined;
      if (current.head.value.legacy || current.state.inventory.version !== 3) return;
      const summary = readApiSummary(current.head.value, context(uid));
      if (!summary || !canReuseSyncMigration(summary.migration, Date.now())) return;
      return { head: current.head, blobs: current.blobs };
    },
    readSnapshotHead: uid => headStore.read(uid),
    async hasReadSnapshot(uid) {
      try {
        const value = await snapshot(uid, undefined, { useReadSnapshot: true, preparedOnly: true, viewOnly: true });
        return value.head.exists && !value.viewMissing && !value.needsPreparation;
      } catch (_) { return false; }
    },
    async readCards(uid, inputNumbers) {
      const numbers = selectedNumbers(inputNumbers);
      return selectedSnapshot(uid, numbers);
    },
    async readMetadata(uid, { forSync = false } = {}) {
      const base = root(uid);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const fields = ['format', 'generation', 'tombstone', 'payload/type', 'payload/version',
          ...(forSync === true ? [`payload/apiSummary/value/value/${encodeKey('migration')}`] : ['payload/header/updatedAt', 'payload/cards/count'])];
        let revision, values;
        if (forSync === true) {
          // 이미 받은 snapshot의 알려진 revision과 마지막 fresh revision이 같을
          // 때만 재사용한다. 단조 revision/CAS를 전제로 작은 제어 필드를 병렬 조회한다.
          [revision, ...values] = await Promise.all(['revision', ...fields].map(field => access.read(`${base}/${field}`)));
        } else {
          revision = await access.read(`${base}/revision`);
          values = await Promise.all(fields.map(field => access.read(`${base}/${field}`)));
        }
        const after = await access.read(`${base}/revision`);
        if (revision !== after) continue;
        const [format, generation, tombstone, type, version, updatedAt, cardCount] = values;
        if (revision === null && values.every(value => value === null)) {
          return { exists: false, revision: 0, generation: 0, storageFormat: 'empty', cardCount: 0 };
        }
        if (format !== 1) throw fail('USER_STORAGE_UNSUPPORTED_FORMAT', '지원하지 않는 사용자 저장 형식입니다.');
        if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(generation)
            || generation < 0 || generation > revision || typeof tombstone !== 'boolean' || (tombstone && !generation)) {
          throw fail('USER_STORAGE_INVALID_RECORD', '인벤토리 메타데이터가 올바르지 않습니다.');
        }
        const record = { exists: !tombstone, revision, generation };
        if (type !== 'inventory-parts') {
          if (type !== null && type !== 'inventory') throw fail('USER_STORAGE_UNSUPPORTED_FORMAT', '지원하지 않는 인벤토리 저장 형식입니다.');
          if (version !== 1 && !(tombstone && version === null && type === null)) {
            throw fail('USER_STORAGE_UNSUPPORTED_FORMAT', '지원하지 않는 인벤토리 저장 형식입니다.');
          }
          return { ...record, storageFormat: 'legacy' };
        }
        if (version !== 1 || (forSync !== true && cardCount !== null && (!Number.isSafeInteger(cardCount) || cardCount < 0))) {
          throw fail('USER_STORAGE_INVALID_RECORD', '인벤토리 메타데이터가 올바르지 않습니다.');
        }
        if (forSync === true) return { ...record, storageFormat: 'parts', syncMigration: readSyncMigration(values[5]) };
        return { ...record, storageFormat: 'parts', ...(cardCount === null ? {} : { cardCount }),
          ...(updatedAt === null ? {} : { updatedAt }) };
      }
      throw conflict();
    },
    update, updateCards, updateApiCards,
    async inspectOperation(uid, id) { return report(id, (await operationSnapshot(uid, id)).operation); },
    recoverOperation,
    async clear(uid, expectedRevision) {
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
        throw fail('USER_STORAGE_INVALID_REVISION', '사용자 데이터 버전이 올바르지 않습니다.');
      }
      const current = await snapshot(uid);
      if (expectedRevision !== undefined && expectedRevision !== current.head.revision) throw conflict();
      const saved = await publish(uid, current.head, { blobs: [] }, entries(uid, current.head.value), 'clear');
      return { ...saved.head, operationId: saved.operationId, value: undefined,
        ...(saved.cleanupPending ? { cleanupPending: true } : {}) };
    },
  };
  return api;
}

module.exports = { createPartitionedInventoryStore };
