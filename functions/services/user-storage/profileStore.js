'use strict';

const { createRecordStore } = require('./recordStore');
const { encodeValue, decodeValue } = require('./codec');
const { createProfilePayloadCodec, serverTimestampPaths } = require('./profileCodec');
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const invalid = () => Object.assign(new Error('사용자 프로필 변경 형식이 올바르지 않습니다.'), { code: 'USER_STORAGE_INVALID_PROFILE_PATCH' });

function validatePatch(value, active = new Set()) {
  if (value === null || typeof value !== 'object') return;
  if (active.has(value)) throw invalid();
  active.add(value);
  if (plain(value) || Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (unsafe.has(key)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw invalid();
      validatePatch(descriptor.value, active);
    }
  }
  active.delete(value);
}

function merge(current, patch) {
  const result = plain(current)
    ? Object.defineProperties(Object.create(Object.getPrototypeOf(current)), Object.getOwnPropertyDescriptors(current)) : {};
  for (const key of Object.keys(patch)) {
    if (unsafe.has(key)) throw invalid();
    // Firestore set(..., {merge:true})도 명시한 빈 map은 해당 필드를 교체한다.
    result[key] = plain(patch[key]) && Object.keys(patch[key]).length ? merge(current?.[key], patch[key]) : patch[key];
  }
  return result;
}

function createProfileStore(options = {}) {
  const payloadCodec = createProfilePayloadCodec(options.payloadCodec);
  const store = createRecordStore({ ...options, path: options.path ?? 'users', suffix: options.suffix ?? 'profile', payloadCodec });
  const read = async uid => {
    const record = await store.read(uid);
    if (record.exists && !plain(record.value)) throw invalid();
    return record;
  };
  function prepare(patch, updateOptions) {
    if (!plain(patch)) throw invalid();
    if (!plain(updateOptions)) throw invalid();
    validatePatch(patch);
    const paths = serverTimestampPaths(patch, updateOptions.serverTimestampPaths);
    // 호출자가 처리 도중 patch/경로 목록을 바꿔도 저장 내용이 변하지 않는다.
    const stable = decodeValue(encodeValue(patch));
    payloadCodec.withServerTimestamps(stable, paths);
    return { stable, paths };
  }
  return {
    read,
    async update(uid, patch, updateOptions = {}) {
      const { stable, paths } = prepare(patch, updateOptions);
      const { record } = await store.update(uid, value => {
        if (value !== undefined && !plain(value)) throw invalid();
        return { value: payloadCodec.withServerTimestamps(merge(value, stable), paths) };
      }, updateOptions);
      return record;
    },
    async createIfAbsent(uid, value, createOptions = {}) {
      const { stable } = prepare(value, createOptions);
      const attempts = createOptions.maxAttempts ?? options.maxAttempts ?? 3;
      if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
        throw Object.assign(new Error('변경 재시도 횟수가 올바르지 않습니다.'), { code: 'USER_STORAGE_INVALID_UPDATE' });
      }
      let generation;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const current = await read(uid);
        if (generation === undefined) generation = current.generation;
        if (current.generation !== generation) {
          throw Object.assign(new Error('처리 중 데이터가 초기화되었습니다. 다시 조회해 주세요.'), { code: 'USER_STORAGE_CONFLICT' });
        }
        if (current.exists) {
          return { record: current, created: false };
        }
        try { return { record: await store.compareAndSet(uid, current.revision, stable), created: true }; }
        catch (error) {
          if (error.code !== 'USER_STORAGE_CONFLICT' || attempt + 1 === attempts) throw error;
        }
      }
    }
  };
}

module.exports = { createProfileStore, mergeProfile: merge, validateProfilePatch: validatePatch };
