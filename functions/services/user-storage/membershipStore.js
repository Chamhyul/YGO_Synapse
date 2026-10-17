'use strict';

const { createHash } = require('node:crypto');
const { encodeKey, encodeValue, decodeValue } = require('./codec');
const { createProfilePayloadCodec } = require('./profileCodec');
const { createStorageAccess, validateStoragePath } = require('./storageAccess');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (code, message) => Object.assign(new Error(message), { code });
const invalidState = () => fail('USER_STORAGE_INVALID_MEMBERSHIP_STATE', '멤버십 인증 상태가 올바르지 않습니다.');
const invalidMembership = () => fail('USER_STORAGE_INVALID_MEMBERSHIP', '멤버십 저장 형식이 올바르지 않습니다.');
const expired = () => fail('MEMBERSHIP_VERIFICATION_EXPIRED', '인증이 만료되었거나 이미 사용되었습니다. 다시 인증해 주세요.');
const hashPattern = /^[a-f0-9]{64}$/;
const redirects = new Set(['https://ygo-synapse.web.app/', 'http://localhost:5005/']);
const validTime = value => Number.isSafeInteger(value) && value >= 0;

function fields(value, required, optional = []) {
  if (!plain(value)) return false;
  const keys = Reflect.ownKeys(value);
  return required.every(key => own(value, key)) && keys.every(key => typeof key === 'string'
    && [...required, ...optional].includes(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable
    && own(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

// 속성 순서와 일반 설정 변경은 claim 원본 버전을 바꾸지 않는다.
function membershipVersion(membership) {
  if (membership === undefined) return '0';
  const canonical = value => value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(encodeValue(membership)))).digest('hex');
}

function validateMembership(membership, provider) {
  const identity = provider === 'discord' ? 'discordId' : 'userChannelId';
  if (!fields(membership, ['status', 'type', 'levelName', identity, 'verificationVersion', 'verificationProvider', 'lastChecked'])
      || !['active', 'none'].includes(membership.status)
      || membership.type !== (provider === 'discord' ? 'discord' : 'csv')
      || typeof membership.levelName !== 'string' || !membership.levelName || membership.levelName.length > 1024
      || membership.verificationVersion !== 2 || membership.verificationProvider !== provider
      || !validTime(membership.lastChecked)
      || typeof membership[identity] !== 'string'
      || !(provider === 'discord' ? /^\d{17,20}$/ : /^UC[A-Za-z0-9_-]{22}$/).test(membership[identity])) throw invalidMembership();
  return decodeValue(encodeValue(membership));
}

function validateState(state, provider, stored = true) {
  const required = ['nonceHash', 'startedAt', 'expiresAt', 'localOnly'];
  if (stored) required.push('consumed', 'completed', 'profileGeneration');
  if (provider === 'discord') required.push('redirectUri');
  if (!fields(state, required, stored ? [] : ['consumed'])
      || typeof state.nonceHash !== 'string' || !hashPattern.test(state.nonceHash)
      || !validTime(state.startedAt) || !validTime(state.expiresAt) || state.expiresAt - state.startedAt !== 300000
      || typeof state.localOnly !== 'boolean'
      || (provider === 'discord' && !redirects.has(state.redirectUri))
      || (!stored && own(state, 'consumed') && state.consumed !== false)
      || (stored && (typeof state.consumed !== 'boolean' || typeof state.completed !== 'boolean'
        || (state.completed && !state.consumed) || !validTime(state.profileGeneration)))) throw invalidState();
  return { ...state };
}

function createMembershipStore({ database, now = Date.now, ...options } = {}) {
  if (typeof now !== 'function') throw fail('USER_STORAGE_INVALID_CONFIG', '사용자 저장소 설정이 올바르지 않습니다.');
  const access = createStorageAccess({ database, ...options });
  const codec = createProfilePayloadCodec(options.payloadCodec);
  function target(uid, provider) {
    if (typeof uid !== 'string' || !uid || uid.length > 128 || Buffer.from(uid).toString() !== uid) throw invalidState();
    if (provider !== undefined && !['discord', 'youtube'].includes(provider)) throw invalidState();
    return validateStoragePath(`users/${encodeKey(uid)}`);
  }
  function profile(raw, path) {
    if (raw === null || raw === undefined) return { exists: false, revision: 0, generation: 0, value: undefined };
    if (!plain(raw) || raw.format !== 1) throw fail('USER_STORAGE_UNSUPPORTED_FORMAT', '지원하지 않는 사용자 저장 형식입니다. 원본을 보존합니다.');
    const expected = ['format', 'revision', 'generation', 'tombstone', ...(!raw.tombstone ? ['payload'] : [])];
    if (!fields(raw, expected) || !Number.isSafeInteger(raw.revision) || raw.revision < 1
        || !validTime(raw.generation) || raw.generation > raw.revision || typeof raw.tombstone !== 'boolean'
        || (raw.tombstone && raw.generation === 0)) throw fail('USER_STORAGE_INVALID_RECORD', '사용자 저장 데이터가 올바르지 않습니다. 원본을 보존합니다.');
    const value = raw.tombstone ? undefined : codec.decode(raw.payload, { basePath: `${path}/profile/payload` });
    if (value !== undefined && !plain(value)) throw invalidMembership();
    return { exists: !raw.tombstone, revision: raw.revision, generation: raw.generation, value };
  }
  function parent(raw, path) {
    if (raw !== null && raw !== undefined && !plain(raw)) throw invalidState();
    const value = raw ?? {};
    if (own(value, 'verification') && (!plain(value.verification)
        || Object.keys(value.verification).some(provider => !['discord', 'youtube'].includes(provider)))) throw invalidState();
    for (const [provider, state] of Object.entries(value.verification ?? {})) validateState(state, provider);
    return { value, profile: profile(value.profile, path) };
  }
  function result(record) {
    const membership = record.value?.settings?.membership;
    return { membership, version: membershipVersion(membership) };
  }
  async function transact(path, mutate) {
    access.ensureUsable();
    const ref = database.ref(path);
    let listener, listenerError, callbackError;
    try {
      // 현재 UID만 listener로 유지한다. 최초 null 캐시는 이미 존재하는 프로필을 지우지 못한다.
      const initial = new Promise((resolve, reject) => {
        listener = snapshot => resolve(snapshot);
        ref.on('value', listener, error => { listenerError = error; reject(error); });
      });
      const observed = (await access.guarded(initial)).val();
      parent(observed, path);
      const transaction = await access.guarded(ref.transaction(raw => {
        if (listenerError) return undefined;
        try {
          access.ensureUsable();
          if (raw == null && observed != null) throw fail('USER_STORAGE_CONFLICT', '사용자 데이터가 변경되었습니다. 다시 조회해 주세요.');
          const current = parent(raw, path);
          return mutate(current);
        } catch (error) { callbackError = error; return undefined; }
      }, undefined, false), true);
      access.ensureUsable();
      if (callbackError) throw callbackError;
      if (listenerError) throw listenerError;
      if (!transaction.committed) throw fail('USER_STORAGE_CONFLICT', '사용자 데이터가 변경되었습니다. 다시 조회해 주세요.');
      return parent(transaction.snapshot.val(), path);
    } finally { if (listener) ref.off('value', listener); }
  }
  function active(current, provider, nonceHash, at, consumed) {
    const state = current.value.verification?.[provider];
    if (!state || state.nonceHash !== nonceHash || state.consumed !== consumed || state.completed
        || state.expiresAt <= at || state.profileGeneration !== current.profile.generation) throw expired();
    return state;
  }
  function proof(nonceHash, at) {
    if (typeof nonceHash !== 'string' || !hashPattern.test(nonceHash) || !validTime(at)) throw invalidState();
  }
  const instant = at => typeof at === 'function' ? at() : at;
  return {
    async read(uid) {
      const path = target(uid);
      return result(profile(await access.read(`${path}/profile`), path));
    },
    async start(uid, provider, state) {
      const path = target(uid, provider), stable = validateState(state, provider, false);
      const saved = await transact(path, current => {
        const previous = current.value.verification?.[provider];
        if (previous && stable.startedAt - previous.startedAt < 3000) throw fail('MEMBERSHIP_TOO_MANY_REQUESTS', '잠시 후 다시 인증해 주세요.');
        return { ...current.value, verification: { ...current.value.verification, [provider]: { ...stable,
          consumed: false, completed: false, profileGeneration: current.profile.generation } } };
      });
      return { ...saved.value.verification[provider] };
    },
    async consume(uid, provider, nonceHash, at = now) {
      const path = target(uid, provider); proof(nonceHash, instant(at));
      const saved = await transact(path, current => {
        const checkedAt = instant(at); proof(nonceHash, checkedAt);
        const state = active(current, provider, nonceHash, checkedAt, false);
        return { ...current.value, verification: { ...current.value.verification, [provider]: { ...state, consumed: true } } };
      });
      return { ...saved.value.verification[provider] };
    },
    async complete(uid, provider, nonceHash, membership, at = now) {
      const path = target(uid, provider); proof(nonceHash, instant(at));
      const stable = validateMembership(membership, provider);
      const saved = await transact(path, current => {
        const checkedAt = instant(at); proof(nonceHash, checkedAt);
        const state = active(current, provider, nonceHash, checkedAt, true);
        const next = { ...current.value, verification: { ...current.value.verification,
          [provider]: { ...state, completed: true } } };
        if (!state.localOnly) {
          if (current.value.profile?.tombstone) throw expired();
          if (current.profile.revision === Number.MAX_SAFE_INTEGER) throw fail('USER_STORAGE_REVISION_EXHAUSTED', '사용자 데이터 버전 한도에 도달했습니다.');
          const value = current.profile.value ?? {};
          if (value.settings !== undefined && !plain(value.settings)) throw invalidMembership();
          next.profile = { format: 1, revision: current.profile.revision + 1, generation: current.profile.generation, tombstone: false,
            payload: codec.encode({ ...value, settings: { ...value.settings, membership: stable } }, { basePath: `${path}/profile/payload` }) };
        }
        return next;
      });
      return { ...result(saved.profile), stored: !saved.value.verification[provider].localOnly };
    },
  };
}

module.exports = { createMembershipStore, membershipVersion, validateMembership, validateVerificationState: validateState };
