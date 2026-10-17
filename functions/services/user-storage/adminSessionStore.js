'use strict';

const { createRecordStore, DEFAULT_MAX_ATTEMPTS } = require('./recordStore');
const { encodeValue, decodeValue } = require('./codec');
const IDLE_MS = 30 * 60 * 1000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const failure = (code, message) => Object.assign(new Error(message), { code });
const validUid = uid => typeof uid === 'string' && uid.length > 0 && uid.length <= 128
  && Buffer.from(uid, 'utf8').toString('utf8') === uid;
const validTime = value => Number.isSafeInteger(value) && value >= 0;

function checkHash(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
    throw failure('USER_STORAGE_INVALID_SESSION_KEY', '관리자 세션 식별자가 올바르지 않습니다.');
  }
}

function sessionValue(value) {
  const fields = ['uid', 'lastActivity', 'expiresAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== fields.length
      || fields.some(key => !own(value, key) || !own(Object.getOwnPropertyDescriptor(value, key), 'value'))
      || !validUid(value.uid) || !validTime(value.lastActivity) || !validTime(value.expiresAt)
      || value.expiresAt <= value.lastActivity) {
    throw failure('USER_STORAGE_INVALID_SESSION', '관리자 세션 저장 형식이 올바르지 않습니다. 원본을 보존합니다.');
  }
  return { uid: value.uid, lastActivity: value.lastActivity, expiresAt: value.expiresAt };
}

// 쿠키 원문 대신 SHA-256 식별자 하나만 접근한다. UID와 만료 시각 외 필드는 저장하지 않는다.
function createAdminSessionStore(options = {}) {
  const attempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const observations = new WeakMap();
  const store = createRecordStore({ ...options, path: options.path ?? 'adminSessions', suffix: '',
    payloadCodec: {
      encode: (value, context) => encodeValue(sessionValue(value), context),
      decode: (value, context) => sessionValue(decodeValue(value, context)),
    } });
  const conflict = () => failure('USER_STORAGE_CONFLICT', '처리 중 관리자 세션이 변경되었습니다. 다시 로그인해 주세요.');

  return {
    async get(key) {
      checkHash(key);
      const record = await store.read(key);
      if (!record.exists) return undefined;
      observations.set(record.value, { key, revision: record.revision, generation: record.generation });
      return record.value;
    },
    async set(key, value) {
      checkHash(key);
      const stable = sessionValue(value);
      // update의 generation 검사가 이 로그인 시도 도중의 logout/만료 삭제를 넘지 못하게 한다.
      await store.update(key, () => ({ value: stable }));
    },
    async remove(key, observedValue) {
      checkHash(key);
      if (arguments.length > 1) {
        const observed = observedValue && typeof observedValue === 'object' ? observations.get(observedValue) : undefined;
        if (!observed || observed.key !== key) {
          throw failure('USER_STORAGE_INVALID_SESSION_OBSERVATION', '조회한 관리자 세션 상태가 필요합니다.');
        }
        // 오래된 만료/권한 판정으로 갱신되거나 새로 발급된 세션을 삭제하지 않는다.
        try { await store.delete(key, observed.revision); return true; }
        catch (error) { if (error.code === 'USER_STORAGE_CONFLICT') return false; throw error; }
      }
      for (let attempt = 0; attempt < attempts; attempt++) {
        const current = await store.read(key);
        // logout은 쿠키 인증 전에도 호출된다. 임의 쿠키마다 영구 삭제 표식을 만들지 않는다.
        if (!current.exists) return false;
        try {
          await store.delete(key, current.revision); return true;
        } catch (error) {
          if (error.code !== 'USER_STORAGE_CONFLICT' || attempt + 1 === attempts) throw error;
        }
      }
    },
    async touch(key, uid, now) {
      checkHash(key);
      if (!validUid(uid)) return false;
      if (!validTime(now)) throw failure('USER_STORAGE_INVALID_SESSION_TIME', '관리자 세션 활동 시각이 올바르지 않습니다.');
      let generation;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const current = await store.read(key);
        if (generation === undefined) generation = current.generation;
        if (!current.exists || current.generation !== generation) return false;
        const value = current.value;
        if (value.uid !== uid || value.expiresAt <= now || now - value.lastActivity >= IDLE_MS) return false;
        try {
          await store.compareAndSet(key, current.revision, { ...value, lastActivity: Math.max(value.lastActivity, now) });
          return true;
        } catch (error) {
          if (error.code !== 'USER_STORAGE_CONFLICT') throw error;
          if (attempt + 1 === attempts) {
            // 마지막 CAS 충돌도 확정된 삭제/만료이면 인증 실패로 반환한다. 추가 쓰기는 하지 않는다.
            const latest = await store.read(key);
            if (!latest.exists || latest.generation !== generation || latest.value.uid !== uid
                || latest.value.expiresAt <= now || now - latest.value.lastActivity >= IDLE_MS) return false;
            throw conflict();
          }
        }
      }
    },
  };
}

module.exports = { createAdminSessionStore, IDLE_MS, sessionValue, checkHash };
