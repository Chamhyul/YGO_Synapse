'use strict';
const { measureRtdbGet } = require('../rtdbReadDiagnostics');

const { measure } = require('../inventoryRequestTiming');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');

const { encodeKey, encodeValue, decodeValue } = require('./codec');
const { createStorageAccess, validateStoragePath, DEFAULT_TIMEOUT_MS } = require('./storageAccess');
const FORMAT = 1;
const DEFAULT_MAX_ATTEMPTS = 3;
const forbiddenPath = /[.$#[\]\u0000-\u001f\u007f]/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const failure = (code, message) => Object.assign(new Error(message), { code });
const commitQueues = new WeakMap();

// 같은 SDK 연결의 같은 레코드에서 pending transaction이 캐시에 겹치지 않도록 한다.
// 서버 CAS는 별도로 유지하며 다른 연결 또는 다른 레코드에는 잠금을 걸지 않는다.
function serializeCommit(database, path, work, timeoutMs) {
  let queues = commitQueues.get(database);
  if (!queues) { queues = new Map(); commitQueues.set(database, queues); }
  const previous = queues.get(path) || Promise.resolve();
  let cancelled = false, started = false, timer;
  const queueError = () => failure('USER_STORAGE_QUEUE_TIMEOUT', '저장 대기 시간이 초과되었습니다. 이 변경은 서버에 제출하지 않았습니다.');
  const start = () => {
    if (cancelled) throw queueError();
    started = true;
    clearTimeout(timer);
    return work();
  };
  const task = previous.then(start, start);
  const tail = task.then(() => {}, () => {});
  queues.set(path, tail);
  tail.then(() => {
    if (queues.get(path) === tail) queues.delete(path);
    if (!queues.size && commitQueues.get(database) === queues) commitQueues.delete(database);
  });
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (started) return;
      cancelled = true;
      reject(queueError());
    }, timeoutMs);
    task.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function segments(value, allowEmpty = false) {
  if (allowEmpty && value === '') return [];
  if (typeof value !== 'string' || !value || value.split('/').some(part => !part || forbiddenPath.test(part)
      || Buffer.from(part, 'utf8').toString('utf8') !== part
      || Buffer.byteLength(part, 'utf8') > 768)) {
    throw failure('USER_STORAGE_INVALID_PATH', '사용자 저장 경로가 올바르지 않습니다.');
  }
  return value.split('/');
}

function checkRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure('USER_STORAGE_INVALID_REVISION', '사용자 데이터 버전이 올바르지 않습니다.');
  }
}

function checkReceipt(receipt, revision, generation) {
  const fields = ['id', 'digest', 'outcome', 'revision', 'generation'];
  if (receipt && own(receipt, 'reason')) fields.push('reason');
  return receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && Object.keys(receipt).length === fields.length && fields.every(key => own(receipt, key))
    && typeof receipt.id === 'string' && /^[a-f0-9]{32}$/.test(receipt.id)
    && typeof receipt.digest === 'string' && /^[a-f0-9]{64}$/.test(receipt.digest)
    && ['committed', 'cancelled'].includes(receipt.outcome)
    && (!own(receipt, 'reason') || receipt.outcome === 'cancelled' && ['conflict', 'inactive', 'fenced'].includes(receipt.reason))
    && Number.isSafeInteger(receipt.revision) && receipt.revision > 0 && receipt.revision <= revision
    && Number.isSafeInteger(receipt.generation) && receipt.generation >= 0 && receipt.generation <= generation;
}

function decodeRecord(raw, { path, payloadCodec, retainOnDelete, allowReceipt = false }) {
  if (raw === null || raw === undefined) return { exists: false, value: undefined, revision: 0, generation: 0 };
  if (typeof raw !== 'object' || Array.isArray(raw) || raw.format !== FORMAT) {
    throw failure('USER_STORAGE_UNSUPPORTED_FORMAT', '지원하지 않는 사용자 저장 형식입니다. 원본을 보존합니다.');
  }
  const retained = raw.tombstone === true && own(raw, 'payload') && retainOnDelete !== undefined;
  const allowed = raw.tombstone === true && !retained ? ['format', 'revision', 'generation', 'tombstone']
    : ['format', 'revision', 'generation', 'tombstone', 'payload'];
  if (allowReceipt && own(raw, 'commitReceipt')) allowed.push('commitReceipt');
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1
      || !Number.isSafeInteger(raw.generation) || raw.generation < 0 || raw.generation > raw.revision
      || typeof raw.tombstone !== 'boolean' || (raw.tombstone && raw.generation === 0)
      || Object.keys(raw).length !== allowed.length || allowed.some(key => !own(raw, key))
      || (own(raw, 'commitReceipt') && !checkReceipt(raw.commitReceipt, raw.revision, raw.generation))) {
    throw failure('USER_STORAGE_INVALID_RECORD', '사용자 저장 데이터가 올바르지 않습니다. 원본을 보존합니다.');
  }
  if (own(raw, 'commitReceipt')) validateStoragePath(`${path}/commitReceipt/generation`);
  return { exists: !raw.tombstone, value: raw.tombstone && !retained ? undefined : payloadCodec.decode(raw.payload, { basePath: `${path}/payload` }),
    revision: raw.revision, generation: raw.generation,
    ...(own(raw, 'commitReceipt') ? { commitReceipt: { ...raw.commitReceipt } } : {}) };
}

// SDK/프로젝트 생성 없이 주입받은 DB의 단일 레코드만 접근한다.
function createRecordStore({ database, path, suffix = '', timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS, onAmbiguousWrite,
  payloadCodec = { encode: encodeValue, decode: decodeValue }, recordCodec, retainOnDelete, archiveReceipt } = {}) {
  const prefix = segments(path), tail = segments(suffix, true);
  const payloadDepth = prefix.length + 1 + tail.length + 1; // id와 payload 포함
  if (!database || typeof database.ref !== 'function' || payloadDepth >= 32
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10
      || (onAmbiguousWrite !== undefined && typeof onAmbiguousWrite !== 'function')
      || !payloadCodec || typeof payloadCodec.encode !== 'function' || typeof payloadCodec.decode !== 'function'
      || (recordCodec !== undefined && (!recordCodec || typeof recordCodec.encode !== 'function' || typeof recordCodec.decode !== 'function'))
      || (retainOnDelete !== undefined && typeof retainOnDelete !== 'function')
      || (archiveReceipt !== undefined && typeof archiveReceipt !== 'function')) {
    throw failure('USER_STORAGE_INVALID_CONFIG', '사용자 저장소 설정이 올바르지 않습니다.');
  }
  const { ensureUsable, guarded: bounded } = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const sessions = new AsyncLocalStorage();
  function watch(ref) {
    const observed = { ref, snapshot: undefined, error: undefined };
    observed.ready = new Promise((resolve, reject) => {
      observed.onValue = snapshot => { observed.snapshot = snapshot; resolve(); };
      ref.on('value', observed.onValue, error => { observed.error = error; reject(error); });
    });
    return observed;
  }
  function observation(ref, path) {
    const active = sessions.getStore();
    if (!active) return watch(ref);
    if (!active.has(path)) active.set(path, watch(ref));
    return active.get(path);
  }
  async function latest(observed) {
    await measure('record.observe', () => bounded(observed.ready, false)); ensureUsable();
    if (observed.error) throw observed.error;
    return observed.snapshot;
  }
  async function withSession(action) {
    if (sessions.getStore()) return action();
    return sessions.run(new Map(), async () => {
      try { return await action(); }
      finally { for (const observed of sessions.getStore().values()) observed.ref.off('value', observed.onValue); }
    });
  }
  const targetFor = id => {
    const path = [...prefix, encodeKey(id), ...tail].join('/');
    // 각 키뿐 아니라 SDK 절대경로(선행 / 포함)와 레코드 메타데이터도 한도를 지킨다.
    validateStoragePath(`${path}/generation`);
    return { path, ref: database.ref(validateStoragePath(path)) };
  };

  // 전용 journal의 물리 헤더/본문만 변환한다. 기본 레코드 형식과 CAS/영수증 경계는 유지한다.
  const normalize = (raw, path) => recordCodec ? recordCodec.decode(raw, { basePath: path }) : raw;
  const parseNormal = (raw, path) => decodeRecord(raw, { path, payloadCodec, retainOnDelete, allowReceipt: !!archiveReceipt });
  const parse = (raw, path) => parseNormal(normalize(raw, path), path);

  async function read(id) {
    ensureUsable();
    const { ref, path } = targetFor(id);
    // 첫 읽기·충돌 재조회는 서버 get의 최신값 계약을 유지한다. 명령의 구독 준비만
    // 동시에 수행하여 순차 대기를 줄이며, 구독 캐시를 fresh read로 대체하지 않는다.
    const snapshot = sessions.getStore()
      ? (await Promise.all([measure('record.get', () => bounded(measureRtdbGet(database, 'record', () => ref.get()), false)), latest(observation(ref, path))]))[0]
      : await measure('record.get', () => bounded(measureRtdbGet(database, 'record', () => ref.get()), false));
    ensureUsable();
    return measure('record.decode', () => parse(snapshot.val(), path));
  }

  async function commit(id, expectedRevision, value, tombstone, options = {}, fenceOnly = false) {
    ensureUsable();
    checkRevision(expectedRevision);
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw failure('USER_STORAGE_INVALID_OPERATION', '사용자 데이터 작업 식별자가 올바르지 않습니다.');
    }
    const { operationId, operationDigest } = options;
    if (options.validateCurrent !== undefined && typeof options.validateCurrent !== 'function'
        || options.cancellationReason !== undefined && (!fenceOnly || !['conflict', 'inactive', 'fenced'].includes(options.cancellationReason))) {
      throw failure('USER_STORAGE_INVALID_OPERATION', '사용자 데이터 작업 조건이 올바르지 않습니다.');
    }
    const withReceipt = operationId !== undefined || operationDigest !== undefined;
    if (withReceipt && (!archiveReceipt || typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId)
        || typeof operationDigest !== 'string' || !/^[a-f0-9]{64}$/.test(operationDigest))) {
      throw failure('USER_STORAGE_INVALID_OPERATION', '사용자 데이터 작업 식별자가 올바르지 않습니다.');
    }
    if (expectedRevision === Number.MAX_SAFE_INTEGER) throw failure('USER_STORAGE_REVISION_EXHAUSTED', '사용자 데이터 버전 한도에 도달했습니다.');
    const { ref, path } = targetFor(id);
    if (withReceipt) validateStoragePath(`${path}/commitReceipt/generation`);
    const payload = tombstone || fenceOnly ? undefined : payloadCodec.encode(value, { basePath: `${path}/payload` });
    return serializeCommit(database, path, async () => {
      ensureUsable();
      const observedRef = observation(ref, path);
      try {
        // get()의 일회성 조회는 트랜잭션용 캐시를 유지하지 않는다. 첫 snapshot을 받은 뒤
        // 이 레코드의 listener만 승인/실패까지 유지하고, 성공 여부는 서버 CAS로 확인한다.
        const observedRaw = (await latest(observedRef)).val();
        const observed = parse(observedRaw, path);
        ensureUsable();
        if (observed.revision !== expectedRevision) throw failure('USER_STORAGE_CONFLICT', '사용자 데이터가 변경되었습니다. 다시 조회해 주세요.');
        if (observedRef.error) throw observedRef.error;
        // 직전 확정 결과를 먼저 영구 보관한다. 이후 writer가 receipt를 교체해도
        // 늦은 응답의 반영 여부를 확인할 수 있으며 보관 실패 시 CAS를 제출하지 않는다.
        if (observed.commitReceipt) {
          await bounded(archiveReceipt(id, { ...observed.commitReceipt }), false);
          ensureUsable();
          if (observedRef.error) throw observedRef.error;
        }
        const retainedPayload = (tombstone || (fenceOnly && observed.revision === 0)) && retainOnDelete
          ? payloadCodec.encode(retainOnDelete(observed.value), { basePath: `${path}/payload` }) : undefined;
        function propose(currentRaw, current) {
          const firstFence = fenceOnly && current.revision === 0;
          const next = fenceOnly && !firstFence ? { ...currentRaw, revision: expectedRevision + 1 }
            : { format: FORMAT, revision: expectedRevision + 1,
              generation: current.generation + (tombstone || firstFence ? 1 : 0), tombstone: tombstone || firstFence };
          if (!fenceOnly && !tombstone) next.payload = payload;
          else if ((tombstone || firstFence) && retainOnDelete) next.payload = retainedPayload;
          if (withReceipt) {
            next.commitReceipt = { id: operationId, digest: operationDigest,
              outcome: fenceOnly ? 'cancelled' : 'committed', revision: next.revision, generation: next.generation,
              ...(options.cancellationReason ? { reason: options.cancellationReason } : {}) };
          } else if (current.commitReceipt) next.commitReceipt = { ...current.commitReceipt };
          return recordCodec ? recordCodec.encode(next, { basePath: path }) : next;
        }
        // 전용 journal의 확정 관측값으로 제안을 한 번 만든다. SDK 콜백의 원문 전체가
        // 정확히 같을 때만 재사용하고, 새 값/구형/손상/충돌은 기존 검증 경로로 처리한다.
        // 사용자 validator·삭제 보존·영수증 보관이 있는 일반 업무 레코드는 대상이 아니다.
        const reuseProposal = recordCodec && !options.validateCurrent && !retainOnDelete && !archiveReceipt;
        const preparedProposal = reuseProposal ? propose(normalize(observedRaw, path), observed) : undefined;
        let callbackError;
        const result = await measure('record.transaction', () => bounded(ref.transaction(raw => {
          if (observedRef.error) return undefined;
          try {
            ensureUsable();
            if (reuseProposal && isDeepStrictEqual(raw, observedRaw)) return preparedProposal;
            const currentRaw = normalize(raw, path), current = parseNormal(currentRaw, path);
            // 최초 콜백의 null만으로 부재를 확정하지 않는다. 기존 revision이 있으면 쓰기를 중단한다.
            // revision0 제안도 서버가 현재 값을 대조해 재실행/승인한 경우에만 성공이다.
            if (current.revision !== expectedRevision) return undefined;
            if (options.validateCurrent) options.validateCurrent(current);
            // 최초 생성 전 fence도 삭제 경계를 남겨 진행 중이던 generation 0 요청을 막는다.
            // 기존 레코드에서는 본문·삭제 여부·generation을 바꾸지 않고 revision만 전진한다.
            return propose(currentRaw, current);
          } catch (error) { callbackError = error; return undefined; }
        }, undefined, false), true));
        ensureUsable();
        // 충돌 뒤에도 서버가 반환한 현재 snapshot을 재시도에서 사용한다.
        observedRef.snapshot = result.snapshot;
        if (callbackError) throw callbackError;
        if (!result.committed) {
          if (observedRef.error) throw observedRef.error;
          throw failure('USER_STORAGE_CONFLICT', '사용자 데이터가 변경되었습니다. 다시 조회해 주세요.');
        }
        return parse(result.snapshot.val(), path);
      } finally {
        if (!sessions.getStore()) ref.off('value', observedRef.onValue);
      }
    }, timeoutMs);
  }

  // 불변 주소의 최초 생성 전용. null 제안도 서버 transaction이 실제 부재를 확인한다.
  // 존재하는 주소는 수정하지 않으며 호출자가 conflict 뒤 fresh read로 원문을 대조한다.
  async function createIfAbsent(id, value) {
    ensureUsable();
    const { ref, path } = targetFor(id);
    const next = { format: FORMAT, revision: 1, generation: 0, tombstone: false,
      payload: payloadCodec.encode(value, { basePath: `${path}/payload` }) };
    const encoded = recordCodec ? recordCodec.encode(next, { basePath: path }) : next;
    return serializeCommit(database, path, async () => {
      ensureUsable();
      let callbackError;
      const result = await measure('record.transaction', () => bounded(ref.transaction(raw => {
        try { ensureUsable(); return raw === null ? encoded : undefined; }
        catch (error) { callbackError = error; return undefined; }
      }, undefined, false), true));
      ensureUsable();
      if (callbackError) throw callbackError;
      if (!result.committed) throw failure('USER_STORAGE_CONFLICT', '이미 저장된 불변 자료를 대조해야 합니다.');
      return parse(result.snapshot.val(), path);
    }, timeoutMs);
  }

  async function update(id, mutate, options = {}) {
    if (typeof mutate !== 'function') throw failure('USER_STORAGE_INVALID_UPDATE', '사용자 데이터 변경 함수가 필요합니다.');
    const attempts = options.maxAttempts ?? maxAttempts;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) throw failure('USER_STORAGE_INVALID_UPDATE', '변경 재시도 횟수가 올바르지 않습니다.');
    let initialGeneration;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = await read(id);
      if (initialGeneration === undefined) initialGeneration = current.generation;
      if (current.generation !== initialGeneration) throw failure('USER_STORAGE_CONFLICT', '처리 중 데이터가 초기화되었습니다. 다시 조회해 주세요.');
      // 비동기 준비·변경은 SDK 트랜잭션 밖에서 실행하고 매 시도 최신 값으로 다시 계산한다.
      const change = await mutate(current.value, { exists: current.exists, revision: current.revision,
        generation: current.generation, attempt });
      if (!change || typeof change !== 'object' || !own(change, 'value')) throw failure('USER_STORAGE_INVALID_UPDATE', '변경할 사용자 데이터가 필요합니다.');
      try {
        const record = await commit(id, current.revision, change.value, false);
        return { record, result: change.result };
      } catch (error) {
        if (error.code !== 'USER_STORAGE_CONFLICT' || attempt + 1 === attempts) throw error;
      }
    }
  }

  return { read, compareAndSet: (id, revision, value, options) => commit(id, revision, value, false, options),
    delete: (id, revision, options) => commit(id, revision, undefined, true, options),
    fence: (id, revision, options) => commit(id, revision, undefined, false, options, true), update, createIfAbsent, withSession };
}

module.exports = { createRecordStore, decodeRecord, checkCommitReceipt: checkReceipt, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS };
