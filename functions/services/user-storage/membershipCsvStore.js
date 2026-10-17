'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const { createRecordStore } = require('./recordStore');
const { membershipCsvValidateMembers } = require('../membershipCsvService');
const OPERATION = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const PENDING_MS = 2 * 60 * 1000;
const CONTROL_LIMIT = 32;
const EMPTY_REVISION = 'empty-' + createHash('sha256').update('[]').digest('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (code = 'MEMBERSHIP_CSV_UNAVAILABLE', status = 503) => Object.assign(
  new Error(status === 409 ? '회원 목록이 변경되었습니다. 파일 내용을 다시 확인해 주세요.' : '회원 목록을 확인하지 못했습니다.'), { code, status });
const conflict = () => failure('MEMBERSHIP_CSV_CONFLICT', 409);
const idCheck = id => { if (typeof id !== 'string' || !OPERATION.test(id)) throw failure('MEMBERSHIP_CSV_INVALID', 400); };
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function validateOperation(record) {
  if (!fields(record, ['binding', 'revision', 'actor', 'startedAt', 'status', ...(record?.status === 'completed' ? ['completedAt'] : []),
    ...(record?.legacyResult !== undefined ? ['legacyResult'] : [])])
      || !HASH.test(record.binding) || typeof record.actor !== 'string' || !record.actor || record.actor.length > 128
      || !['pending', 'completed', 'failed'].includes(record.status) || !validTime(record.startedAt)
      || (record.revision !== EMPTY_REVISION && !OPERATION.test(record.revision)) || (record.status === 'completed' && !validTime(record.completedAt))
      || (record.legacyResult !== undefined && record.status !== 'completed')) throw failure();
  return record;
}
function controlValue(value) {
  if (value === undefined) return { active: null, operations: {} };
  if (!fields(value, ['active', 'operations']) || !plain(value.operations) || Object.keys(value.operations).length > CONTROL_LIMIT) throw failure();
  if (value.active !== null && (!fields(value.active, ['revision', 'fingerprint', 'count', 'updatedAt']) || !OPERATION.test(value.active.revision)
      || !HASH.test(value.active.fingerprint) || !Number.isInteger(value.active.count) || value.active.count < 1
      || !(value.active.updatedAt === null || validTime(value.active.updatedAt)))) throw failure();
  for (const [id, record] of Object.entries(value.operations)) { if (!OPERATION.test(id) || record.legacyResult !== undefined) throw failure(); validateOperation(record); }
  return value;
}
function candidateValue(value) {
  try {
    if (!fields(value, ['members', 'fingerprint']) || !HASH.test(value.fingerprint)) throw failure();
    const members = membershipCsvValidateMembers(value.members);
    if (digest(members) !== value.fingerprint || !equal(members, value.members)) throw failure();
    return { members, fingerprint: value.fingerprint };
  } catch (_) { throw failure(); }
}

// 회원 본문은 불변 후보에 저장하고 작은 control만 CAS한다. 전체 사용자 트리를 읽거나 잠그지 않는다.
function createMembershipCsvStore(options = {}) {
  const { now = Date.now, path = 'membershipCsv', records } = options;
  const control = records?.control || createRecordStore({ ...options, path: `${path}/control` });
  const candidates = records?.candidates || createRecordStore({ ...options, path: `${path}/candidates` });
  const archives = records?.operations || createRecordStore({ ...options, path: `${path}/operations` });
  const checkControl = records?.validateControl || controlValue, checkCandidate = records?.validateCandidate || candidateValue;
  const checkOperation = records?.validateOperation || validateOperation;
  const activeRevision = records?.revisionOf || (state => state.active?.revision || EMPTY_REVISION);
  async function readControl() { return checkControl((await control.read('current')).value); }
  async function candidate(id) {
    const record = await candidates.read(id);
    if (!record.exists) throw failure();
    return checkCandidate(record.value);
  }
  function resultFor(item, id, updatedAt) {
    const tiers = new Map(); for (const member of item.members) tiers.set(member.levelName, (tiers.get(member.levelName) || 0) + 1);
    return { count: item.members.length, tiers: [...tiers].map(([levelName, count]) => ({ levelName, count })), revision: id, updatedAt };
  }
  async function hydrated(id, record) {
    if (!record || record.status !== 'completed') return record;
    const generated = resultFor(await candidate(id), id, record.completedAt);
    if (record.legacyResult !== undefined) {
      const original = record.legacyResult;
      const tiers = value => value.map(item => [item.levelName, item.count]).sort((a, b) => a[0].localeCompare(b[0]));
      if (!fields(original, ['count', 'tiers', 'revision', 'updatedAt']) || original.count !== generated.count
          || original.revision !== id || original.updatedAt !== record.completedAt || !Array.isArray(original.tiers)
          || !original.tiers.every(item => fields(item, ['levelName', 'count']) && typeof item.levelName === 'string' && Number.isSafeInteger(item.count) && item.count > 0)
          || !equal(tiers(original.tiers), tiers(generated.tiers))) throw failure();
      const { legacyResult, ...summary } = record;
      return { ...summary, result: original };
    }
    return { ...record, result: generated };
  }
  async function archive(id, record) {
    const previous = await archives.read(id);
    if (previous.exists) {
      if (!equal(previous.value, record)) throw failure();
      return;
    }
    try { await archives.compareAndSet(id, 0, record); }
    catch (error) {
      if (error.code !== 'USER_STORAGE_CONFLICT') throw error;
      if (!equal((await archives.read(id)).value, record)) throw failure();
    }
  }
  async function change(mutate) {
    try {
      return (await control.update('current', async value => {
        const state = checkControl(value);
        const result = await mutate(state);
        return { value: state, result };
      })).result;
    } catch (error) { if (error.code === 'USER_STORAGE_CONFLICT') throw conflict(); throw error; }
  }
  async function status(id) {
    idCheck(id);
    const state = await readControl();
    if (state.operations[id]) return hydrated(id, state.operations[id]);
    const old = await archives.read(id);
    return old.exists ? hydrated(id, checkOperation(old.value)) : null;
  }
  async function read() {
    const state = await readControl();
    if (!state.active) return { members: [], revision: activeRevision(state), updatedAt: null };
    const item = await candidate(state.active.revision);
    if (item.members.length !== state.active.count || item.fingerprint !== state.active.fingerprint) throw failure();
    return { members: item.members, revision: activeRevision(state), updatedAt: state.active.publicUpdatedAt !== undefined ? state.active.publicUpdatedAt : state.active.updatedAt };
  }
  return {
    read,
    async readMember(channelId) {
      if (typeof channelId !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) throw failure('MEMBERSHIP_CSV_INVALID', 400);
      // 목록 한 개의 무결성을 확인하여 누락·변조를 비회원 판정으로 바꾸지 않는다.
      return (await read()).members.find(member => member.channelId === channelId) || null;
    },
    status,
    async begin(id, binding, revision, actor, startedAt) {
      idCheck(id);
      const proposal = checkOperation({ binding, revision, actor, startedAt, status: 'pending' });
      const previous = await status(id);
      if (previous) { if (previous.binding !== binding) throw conflict(); return previous; }
      const observed = await readControl();
      if (Object.keys(observed.operations).length >= CONTROL_LIMIT
          && !Object.values(observed.operations).some(record => record.status !== 'pending')) {
        // 중단된 관리자가 결과 조회를 하지 않아도 슬롯이 영구 점유되지 않게 한다.
        // 만료 확정을 먼저 CAS하고 다음 CAS에서 아카이브하므로 늦은 완료와 섞이지 않는다.
        const expired = Object.entries(observed.operations).find(([, record]) => record.startedAt + PENDING_MS <= now());
        if (expired) await change(state => {
          const record = state.operations[expired[0]];
          if (record?.status === 'pending' && record.startedAt + PENDING_MS <= now()) {
            state.operations[expired[0]] = { ...record, status: 'failed' };
          }
        });
      }
      return change(async state => {
        if (state.operations[id]) { if (state.operations[id].binding !== binding) throw conflict(); return hydrated(id, state.operations[id]); }
        const archived = await archives.read(id);
        if (archived.exists) { const old = checkOperation(archived.value); if (old.binding !== binding) throw conflict(); return hydrated(id, old); }
        if (activeRevision(state) !== revision) throw conflict();
        if (Object.keys(state.operations).length >= CONTROL_LIMIT) {
          const entry = Object.entries(state.operations).filter(([, value]) => value.status !== 'pending')
            .sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
          if (!entry) throw conflict();
          // control에서 제거하기 전에 확정 기록을 보존한다. 조회가 두 위치 사이에서 유실되지 않는다.
          await archive(...entry); delete state.operations[entry[0]];
        }
        state.operations[id] = proposal;
        return null;
      });
    },
    async stage(id, input) {
      idCheck(id);
      const record = await status(id);
      if (record?.status !== 'pending' || record.startedAt + PENDING_MS <= now()) throw conflict();
      const members = membershipCsvValidateMembers(input), fingerprint = digest(members);
      if (digest([record.actor, record.revision, fingerprint]) !== record.binding) throw conflict();
      const value = { members, fingerprint }, previous = await candidates.read(id);
      if (previous.exists) {
        if (!equal(checkCandidate(previous.value), value)) throw conflict();
        return;
      }
      try { await candidates.compareAndSet(id, 0, value); }
      catch (error) {
        if (error.code !== 'USER_STORAGE_CONFLICT') throw error;
        if (!equal(await candidate(id), value)) throw conflict();
      }
      if (!equal(await candidate(id), value)) throw failure();
    },
    async commit(id, revision, result) {
      idCheck(id);
      const previous = await status(id);
      if (previous?.status === 'completed') return previous.result;
      const item = await candidate(id);
      const expected = resultFor(item, id, result?.updatedAt);
      if (!plain(result) || result.revision !== id || result.count !== item.members.length || !validTime(result.updatedAt)
          || !equal(result.tiers, expected.tiers)) throw failure();
      return change(async state => {
        const record = state.operations[id];
        if (record?.status === 'completed') return (await hydrated(id, record)).result;
        if (record?.status !== 'pending' || record.startedAt + PENDING_MS <= now() || record.revision !== revision
            || activeRevision(state) !== revision || digest([record.actor, revision, item.fingerprint]) !== record.binding) throw conflict();
        state.active = { revision: id, count: result.count, fingerprint: item.fingerprint, updatedAt: result.updatedAt };
        state.operations[id] = { ...record, status: 'completed', completedAt: result.updatedAt };
        return result;
      });
    },
    async fail(id) {
      idCheck(id);
      const previous = await status(id);
      if (previous?.status === 'completed') return previous.result;
      return change(async state => {
        const record = state.operations[id] || (await archives.read(id)).value;
        if (record?.status === 'completed') return (await hydrated(id, record)).result;
        if (record?.status === 'pending') state.operations[id] = { ...record, status: 'failed' };
        return null;
      });
    },
    async expire(id, time) {
      idCheck(id); if (!validTime(time)) throw failure('MEMBERSHIP_CSV_INVALID', 400);
      const previous = await status(id);
      if (!previous || previous.status !== 'pending') return previous;
      return change(async state => {
        const record = state.operations[id] || (await archives.read(id)).value;
        if (record?.status === 'pending' && record.startedAt + PENDING_MS <= time) state.operations[id] = { ...record, status: 'failed' };
        return hydrated(id, state.operations[id] || record || previous);
      });
    },
  };
}
module.exports = { createMembershipCsvStore, EMPTY_REVISION, CONTROL_LIMIT,
  validateCsvControl: controlValue, validateCsvCandidate: candidateValue, validateCsvOperation: validateOperation };
