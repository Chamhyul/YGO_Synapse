'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { resolveProfileWriterConfig } = require('../config/userProfileWriter');
const { profileReceiptMatches, reserveProfileChange, checkProfileKey } = require('../services/userProfileWriterAdapters');
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: 'a'.repeat(32),
  GCLOUD_PROJECT: 'demo-user-migration', FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-migration-default-rtdb',
  FIRESTORE_EMULATOR_HOST: 'emulators:8080', FIREBASE_STORAGE_EMULATOR_HOST: 'emulators:9199', FIREBASE_AUTH_EMULATOR_HOST: 'emulators:9099' };
test('프로필 writer 설정은 SDK 이전에 demo·네 에뮬레이터·시크릿·운영 플래그를 검사한다', () => {
  assert.equal(resolveProfileWriterConfig(env).runId, 'a'.repeat(32));
  for (const patch of [{ NODE_ENV: 'production' }, { GCLOUD_PROJECT: 'ygo-synapse' }, { USER_PROFILE_WRITER_MODE: 'production' },
    { USER_PROFILE_WRITER_RUN_ID: undefined }, { FIRESTORE_EMULATOR_HOST: 'example.invalid:8080' }, { FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' },
    { USER_DATABASE_URL: 'https://demo.invalid/' }, { FIREBASE_CONFIG: '{}' }, { GOOGLE_APPLICATION_CREDENTIALS: 'not-a-file' }]) {
    assert.throws(() => resolveProfileWriterConfig({ ...env, ...patch }), { code: 'USER_STORAGE_CONFIG_INVALID' });
  }
});
test('서버 시각 receipt는 지정한 null 자리만 Timestamp로 바꿀 수 있다', () => {
  const planned = { key: 'fs/users/synthetic', exists: true, token: '0', value: { createdAt: null, registration: { consent: { acceptedAt: null, terms: 't' } }, settings: { membership: { active: true } } } };
  const op = { changes: [planned], details: { kind: 'profile', serverTimestampPaths: [['createdAt'], ['registration', 'consent', 'acceptedAt']] } };
  const actual = reserveProfileChange(op, planned); actual.token = '1:0';
  assert.ok(actual.value.createdAt instanceof Timestamp); assert.equal(profileReceiptMatches(op, actual, planned), true);
  actual.value.registration.consent.terms = 'different'; assert.equal(profileReceiptMatches(op, actual, planned), false);
  actual.value.registration.consent.terms = 't'; actual.value.createdAt = 1000; assert.equal(profileReceiptMatches(op, actual, planned), false);
  assert.throws(() => reserveProfileChange({ ...op, details: { kind: 'profile', serverTimestampPaths: [['settings', 'membership']] } }, planned));
});
test('프로필 연결의 key는 사용자 문서만 허용한다', () => {
  assert.equal(checkProfileKey('fs/users/synthetic'), 'synthetic');
  for (const key of ['inventory/synthetic', 'fs/cards/a', 'fs/users/a/nested', 'fs/users/', 'fs/users/'+ 'x'.repeat(129)]) assert.throws(() => checkProfileKey(key));
});
