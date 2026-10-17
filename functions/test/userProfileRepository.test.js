'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createRtdbUserProfileRepository } = require('../services/userProfileRepository');
const { sameConnectionConfig } = require('../config/userStorage');

function load(relative, mocks, env = {}) {
  const filename = path.join(__dirname, '..', relative), loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = name => {
    assert.ok(Object.hasOwn(mocks, name), `예상하지 않은 의존성: ${name}`);
    return mocks[name];
  };
  loaded._compile(`const process = { env: ${JSON.stringify(env)} };\n${fs.readFileSync(filename, 'utf8')}`, filename);
  return loaded.exports;
}

test('가입 판정은 프로필 우선이며 프로필 부재만 인벤토리 메타정보로 확인한다', async () => {
  const calls = [];
  let exists = true;
  const repo = createRtdbUserProfileRepository({ storage: {
    profile: { read: async uid => { calls.push(['profile', uid]); return { exists, value: {} }; } },
    inventory: { readMetadata: async uid => { calls.push(['metadata', uid]); return { exists: true }; } },
  } });
  assert.equal(await repo.isRegistered('synthetic'), true);
  assert.deepEqual(calls, [['profile', 'synthetic']]);
  exists = false;
  assert.equal(await repo.isRegistered('synthetic'), true);
  assert.deepEqual(calls.slice(1), [['profile', 'synthetic'], ['metadata', 'synthetic']]);
});

test('프로필 읽기 오류를 인벤토리 가입 판정이나 다른 저장소로 대체하지 않는다', async () => {
  let metadata = 0;
  const failure = Object.assign(Error('합성 실패'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  const repo = createRtdbUserProfileRepository({ storage: {
    profile: { read: async () => { throw failure; } },
    inventory: { readMetadata: async () => { metadata++; return { exists: true }; } },
  } });
  await assert.rejects(repo.isRegistered('synthetic'), failure);
  await assert.rejects(repo.completeRegistration('synthetic', {}), failure);
  await assert.rejects(repo.read('synthetic'), failure);
  assert.equal(metadata, 0);
});

test('기존 인벤토리 회원은 가입 재요청으로 과거 프로필과 동의를 만들지 않는다', async () => {
  let writes = 0;
  const repo = createRtdbUserProfileRepository({ storage: {
    profile: { read: async () => ({ exists: false }), createIfAbsent: async () => { writes++; } },
    inventory: { readMetadata: async () => ({ exists: true }) },
  } });
  await repo.completeRegistration('synthetic', { terms: 't', privacy: 'p' });
  assert.equal(writes, 0);
});

test('잘못된 backend와 RTDB 연결 실패는 기본 Firebase 모듈 접근 전에 거부한다', () => {
  const failure = Object.assign(Error('합성 설정 오류'), { code: 'USER_STORAGE_CONFIG_INVALID' });
  for (const backend of ['unknown', 'rtdb']) {
    const repo = load('services/userProfileRepository.js', {
      './userStorageRuntime': { getRtdbUserStorage() { throw failure; } },
    }, { USER_STORAGE_BACKEND: backend });
    assert.throws(repo.getUserProfileRepository, { code: failure.code });
  }
});

test('기본·명시적 storage backend는 기존 Firestore 문서와 Storage 회원 경로를 유지한다', async () => {
  for (const backend of [undefined, '', 'storage']) {
    const calls = [];
    const repo = load('services/userProfileRepository.js', { '../config/firebase': {
      db: { collection(name) { calls.push(name); return { doc(uid) { calls.push(uid); return { get: async () => ({ exists: false }) }; } }; } },
      getBucket: () => ({ file(filename) { calls.push(filename); return { exists: async () => [true] }; } }),
    } }, { USER_STORAGE_BACKEND: backend }).getUserProfileRepository();
    assert.equal(await repo.isRegistered('synthetic'), true);
    assert.deepEqual(calls, ['users', 'synthetic', 'users/synthetic/inventory.json']);
  }
});

test('프로필과 인벤토리 런타임은 연결을 공유하며 종료 후 자동 재생성하지 않는다', async () => {
  let creates = 0, checks = 0, closes = 0, closed = false;
  const config = { projectId: 'demo-synthetic', databaseURL: 'http://emulators:9000/?ns=demo-synthetic-default-rtdb' };
  const storage = { config, close: async () => { closes++; closed = true; }, profile: {
    read: async () => {
      if (closed) throw Object.assign(Error('종료'), { code: 'USER_STORAGE_CONNECTION_CLOSED' });
      return { exists: true, value: {} };
    },
  }, inventory: {} };
  const runtime = load('services/userStorageRuntime.js', {
    '../config/userStorage': { sameConnectionConfig, resolveUserStorageConfig() { checks++; return { ...config }; } },
    './user-storage': { createConfiguredUserStorage() { creates++; return storage; } },
  });
  const profiles = load('services/userProfileRepository.js', { './userStorageRuntime': runtime }, { USER_STORAGE_BACKEND: 'rtdb' });
  const inventories = load('services/inventoryRepository.js', {
    './userStorageRuntime': runtime,
    './inventoryMigrationService': { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({}) },
  });
  await profiles.getUserProfileRepository().read('synthetic');
  assert.equal(inventories.getRtdbInventoryRepository(), inventories.getRtdbInventoryRepository());
  await inventories.closeRtdbInventoryRepository();
  await assert.rejects(profiles.getUserProfileRepository().read('synthetic'), { code: 'USER_STORAGE_CONNECTION_CLOSED' });
  assert.equal(creates, 1); assert.equal(closes, 1); assert.equal(checks, 4);
});

test('캐시된 RTDB 연결도 매번 설정을 검사하고 실행 중 연결 변경을 거부한다', () => {
  const config = { projectId: 'demo-synthetic', databaseURL: 'http://emulators:9000/?ns=demo-synthetic-default-rtdb' };
  let next = { ...config }, creates = 0;
  const runtime = load('services/userStorageRuntime.js', {
    '../config/userStorage': { sameConnectionConfig, resolveUserStorageConfig() { if (next instanceof Error) throw next; return next; } },
    './user-storage': { createConfiguredUserStorage() { creates++; return { config }; } },
  });
  runtime.getRtdbUserStorage();
  for (const change of [{ databaseURL: 'http://127.0.0.1:9000/?ns=demo-synthetic-default-rtdb' },
    { mode: 'production' }, { instanceId: 'different' }, { location: 'different' },
    { projectId: 'different' }, { targetId: 'different' }, { emulatorHost: 'different' }, { namespace: 'different' }]) {
    next = { ...config, ...change };
    assert.throws(runtime.getRtdbUserStorage, { code: 'USER_STORAGE_CONFIG_INVALID' });
  }
  next = Object.assign(Error('합성 운영 설정 거부'), { code: 'USER_STORAGE_CONFIG_INVALID' });
  assert.throws(runtime.getRtdbUserStorage, next);
  assert.equal(creates, 1);
});
