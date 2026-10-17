'use strict';
const { measure } = require('../inventoryRequestTiming');
const { createRecordStore } = require('./recordStore');
const { createStorageAccess, validateStoragePath } = require('./storageAccess');
const { encodeKey, decodeKey, encodeValue, decodeValue } = require('./codec');
const { fingerprint } = require('../userMigrationRehearsal');
const { validateState, requirements } = require('./writerState');
const fail = () => Object.assign(new Error('전환 상태와 기록의 버전을 확인하지 못했습니다.'), { code: 'WRITER_STATE_INVALID' });
function projection(state, revision, id) {
  validateState(state);
  const value = { format: 1, key: encodeKey(id), revision, backend: state.backend, epoch: state.epoch, phase: state.phase, ...requirements(state) };
  return { ...value, digest: fingerprint(value) };
}
function checkControlFields(value) {
  if (typeof value.key !== 'string'
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !['legacy', 'rtdb'].includes(value.backend) || !Number.isSafeInteger(value.epoch) || value.epoch < 1
      || !['accepting', 'draining'].includes(value.phase)
      || typeof value.requiresPlans !== 'boolean' || typeof value.requiresHistory !== 'boolean') throw fail();
}
function checkProjection(value) {
  if (!value || Object.keys(value).length !== 9 || value.format !== 1) throw fail();
  checkControlFields(value);
  const { digest, ...body } = value; if (digest !== fingerprint(body)) throw fail(); return value;
}
function controlFromHeader(head) {
  const value = { format: 1, key: head.key, revision: head.revision, backend: head.backend,
    epoch: head.epoch, phase: head.phase, requiresPlans: head.requiresPlans, requiresHistory: head.requiresHistory };
  // 같은 호출의 checkHeader가 필드와 헤더 지문을 확인했다. 공개 제어 지문만 한 번 만든다.
  return { ...value, digest: fingerprint(value) };
}
function checkHeader(head, id) {
  if (!head || head.format !== 3 || head.key !== encodeKey(id)
      || !Number.isSafeInteger(head.revision) || head.revision < 1
      || !Number.isSafeInteger(head.generation) || head.generation < 0 || head.generation > head.revision
      || typeof head.tombstone !== 'boolean' || head.tombstone && head.generation === 0
      || head.payloadVersion !== (head.tombstone ? 0 : 1)
      || Object.keys(head).length !== (head.tombstone ? 7 : 12)) throw fail();
  const { digest, ...fields } = head; if (digest !== fingerprint(fields)) throw fail();
  if (!head.tombstone) checkControlFields(head); return head;
}
function encodeJournalRecord(raw, id, basePath) {
  const fields = { format: 3, key: encodeKey(id), revision: raw.revision,
    generation: raw.generation, tombstone: raw.tombstone, payloadVersion: raw.tombstone ? 0 : 1 };
  if (!raw.tombstone) {
    if (raw.payload?.version !== 2) throw fail();
    const { format, digest, ...control } = checkProjection(raw.payload.control);
    if (control.key !== fields.key || control.revision !== fields.revision) throw fail();
    Object.assign(fields, control);
  }
  const head = checkHeader({ ...fields, digest: fingerprint(fields) }, id);
  for (const key of Object.keys(head)) validateStoragePath(`${basePath}/head/${key}`);
  if (raw.tombstone) return { head };
  validateStoragePath(`${basePath}/body/version`);
  return { head, body: { version: 1, value: raw.payload.value } };
}
function decodeJournalRecord(raw, id) {
  if (raw === null || raw === undefined) return raw;
  if (Object.prototype.hasOwnProperty.call(raw, 'head') || Object.prototype.hasOwnProperty.call(raw, 'body')) {
    const head = checkHeader(raw.head, id);
    if (Object.keys(raw).length !== (head.tombstone ? 1 : 2)
        || !head.tombstone && (!raw.body || raw.body.version !== head.payloadVersion
          || Object.keys(raw.body).length !== 2 || !Object.prototype.hasOwnProperty.call(raw.body, 'value'))) throw fail();
    const record = { format: 1, revision: head.revision, generation: head.generation, tombstone: head.tombstone };
    if (!head.tombstone) record.payload = { version: 2, value: raw.body.value, control: controlFromHeader(head) };
    return record;
  }
  // 구형 v2도 부모 revision과 control을 모든 전체 읽기/CAS에서 결합한다.
  if (raw.payload?.version === 2 && (raw.payload.control?.revision !== raw.revision
      || raw.payload.control?.key !== encodeKey(id))) throw fail();
  return raw;
}
// 헤더와 원문은 같은 부모 CAS에서 공개하며 별도 색인/이력을 만들지 않는다.
function createWriterJournalStore({ database, path = 'profileWriterTransitions', timeoutMs = 10000,
  maxAttempts = 10, onAmbiguousWrite } = {}) {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const { isDeepStrictEqual } = require('node:util');
  const { cloneStoredValue: copy } = require('./cloneStoredValue');
  const sessions = new AsyncLocalStorage();
  function withSession(action) {
    const current = sessions.getStore();
    const run = async () => {
      try { return await action(); }
      catch (error) { sessions.getStore().records.clear(); sessions.getStore().payloads.clear(); throw error; }
    };
    return current ? run() : sessions.run({ records: new Map(), payloads: new Map() }, () => store.withSession(run));
  }
  const rememberPayload = (raw, value, options) => {
    sessions.getStore()?.payloads.set(options.basePath, { raw, value: copy(value) });
    return raw;
  };
  validateStoragePath(path);
  const prepared = new WeakMap();
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const idFor = options => {
    const base = options?.basePath;
    if (typeof base !== 'string' || !base.startsWith(`${path}/`) || !base.endsWith('/payload')) throw fail();
    const key = base.slice(path.length + 1, -8); if (key.includes('/')) throw fail(); return decodeKey(key);
  };
  const payloadCodec = {
    encode(value, options) {
      const revision = prepared.get(value); if (!revision) throw fail();
      const encoded = encodeValue(value, options), control = projection(value, revision, idFor(options));
      // 원문의 기존 깊이/하위 경로를 그대로 유지한다.
      for (const key of Object.keys(control)) validateStoragePath(`${options.basePath}/control/${key}`);
      return rememberPayload({ version: 2, value: encoded.value, control }, value, options);
    },
    decode(raw, options) {
      const cached = sessions.getStore()?.payloads.get(options.basePath);
      // SDK가 실제 반환한 원문 전체가 동일할 때만 이 호출에서 검증한 변환을 재사용한다.
      // 새 revision/헤더의 검사와 서버 CAS는 recordStore가 매번 수행한다.
      if (cached && isDeepStrictEqual(raw, cached.raw)) return copy(cached.value);
      if (raw?.version === 1) return decodeValue(raw, options);
      if (raw?.version !== 2 || Object.keys(raw).length !== 3 || !Object.prototype.hasOwnProperty.call(raw, 'value')) throw fail();
      const control = checkProjection(raw.control), value = decodeValue({ version: 1, value: raw.value }, options);
      // 확인한 제어 지문을 본문에서 재계산한 지문과 직접 대조한다. 주소/버전도 지문에 포함된다.
      if (control.digest !== projection(value, control.revision, idFor(options)).digest) throw fail();
      rememberPayload(raw, value, options); return value;
    },
  };
  const idForRecord = options => {
    const base = options?.basePath;
    if (typeof base !== 'string' || !base.startsWith(`${path}/`)) throw fail();
    const key = base.slice(path.length + 1); if (key.includes('/')) throw fail(); return decodeKey(key);
  };
  const recordCodec = {
    encode: (raw, options) => encodeJournalRecord(raw, idForRecord(options), options.basePath),
    decode: (raw, options) => decodeJournalRecord(raw, idForRecord(options)),
  };
  const store = createRecordStore({ database, path, timeoutMs, maxAttempts, onAmbiguousWrite, payloadCodec, recordCodec });
  function prepare(value, revision) { validateState(value); prepared.set(value, revision + 1); }
  async function read(id) {
    const records = sessions.getStore()?.records;
    if (records?.has(id)) return copy(records.get(id));
    const record = await measure('journal.read', () => store.read(id)); records?.set(id, copy(record)); return record;
  }
  async function compareAndSet(id, revision, value) {
    prepare(value, revision);
    try {
      const record = await measure('journal.cas', () => store.compareAndSet(id, revision, value));
      sessions.getStore()?.records.set(id, copy(record)); return record;
    } catch (error) { sessions.getStore()?.records.delete(id); throw error; }
  }
  async function update(id, mutate, options) {
    const invalidUpdate = () => Object.assign(new Error('변경할 사용자 데이터와 재시도 횟수를 확인해 주세요.'), { code: 'USER_STORAGE_INVALID_UPDATE' });
    if (typeof mutate !== 'function') throw invalidUpdate();
    const attempts = options?.maxAttempts ?? maxAttempts;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) throw invalidUpdate();
    let generation;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const record = await read(id); generation ??= record.generation;
      if (generation !== record.generation) throw Object.assign(new Error('처리 중 초기화되었습니다.'), { code: 'USER_STORAGE_CONFLICT' });
      const change = await mutate(record.value, { exists: record.exists, revision: record.revision, generation: record.generation, attempt });
      if (!change || typeof change !== 'object' || !Object.prototype.hasOwnProperty.call(change, 'value')) throw invalidUpdate();
      try { return { record: await compareAndSet(id, record.revision, change.value), result: change.result }; }
      catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT' || attempt + 1 === attempts) throw error; }
    }
  }
  function fromRecord(record, id) {
    if (!record.exists) return { exists: false, revision: record.revision, generation: record.generation };
    const value = projection(record.value, record.revision, id);
    return { exists: true, revision: record.revision, generation: record.generation, value };
  }
  async function readRoute(id) {
    const base = `${path}/${encodeKey(id)}`, raw = await measure('journal.route', () => access.read(`${base}/head`));
    // 구형 기록·부재 또는 누락 헤더는 전체 reader로 확인하며 읽기만으로 이관하지 않는다.
    if (raw === null) return fromRecord(await read(id), id);
    const head = checkHeader(raw, id);
    return { exists: !head.tombstone, revision: head.revision, generation: head.generation,
      ...(!head.tombstone ? { value: controlFromHeader(head) } : {}) };
  }
  async function readExternal(id, operationId) {
    const raw = await access.read(`${path}/${encodeKey(id)}/body/value/${encodeKey('external')}/${encodeKey(operationId)}`);
    if (raw !== null) return decodeValue({ version: 1, value: raw });
    // 구형 envelope는 원문을 그대로 읽으며 조회만으로 이관하지 않는다.
    const head = await access.read(`${path}/${encodeKey(id)}/head`);
    return head === null ? (await store.read(id)).value?.external?.[operationId] : undefined;
  }
  return { read, update, compareAndSet, readRoute, readExternal, withSession };
}
module.exports = { createWriterJournalStore, projection, checkProjection, checkHeader, encodeJournalRecord };
