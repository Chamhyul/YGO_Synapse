'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { membershipVersion, membershipPermissionVersion } = require('../services/user-storage/membershipStore');
const { membershipClaim } = require('../services/membershipClaims');
const source = { status: 'active', type: 'csv', levelName: '합성 회원', userChannelId: 'UC' + 'x'.repeat(22),
  verificationVersion: 2, verificationProvider: 'youtube', lastChecked: 1 };
test('원본 버전은 확인 시각을 감지하지만 권한 버전·claims는 동일하다', () => {
  const next = { ...source, lastChecked: 2 };
  assert.notEqual(membershipVersion(source), membershipVersion(next));
  assert.equal(membershipPermissionVersion(source), membershipPermissionVersion(next));
  assert.deepEqual(membershipClaim({ membership: source, version: membershipVersion(source) }),
    membershipClaim({ membership: next, version: membershipVersion(next) }));
  assert.notEqual(membershipPermissionVersion(source), membershipVersion(source));
});
for (const [key, value] of Object.entries({ status: 'none', type: 'discord', levelName: '다른 등급',
  userChannelId: 'UC' + 'y'.repeat(22), verificationVersion: 1, verificationProvider: 'discord',
  expiresAt: 123, policyVersion: 2, futureField: { lastChecked: 7 } })) test(`권한 필드 ${key} 변경은 새 버전이다`, () => {
  assert.notEqual(membershipPermissionVersion(source), membershipPermissionVersion({ ...source, [key]: value }));
});
test('Discord 신원 변경·미검증·원본 삭제도 새 버전이며 순서만 바뀌면 동일하다', () => {
  const discord = { ...source, type: 'discord', verificationProvider: 'discord', discordId: '123456789012345678' };
  assert.notEqual(membershipPermissionVersion(discord), membershipPermissionVersion({ ...discord, discordId: '223456789012345678' }));
  assert.equal(membershipPermissionVersion(source), membershipPermissionVersion(Object.fromEntries(Object.entries(source).reverse())));
  assert.equal(membershipPermissionVersion(undefined), '0');
  assert.notEqual(membershipPermissionVersion(source), membershipPermissionVersion(undefined));
  assert.equal(membershipClaim({ membership: { ...source, verificationVersion: 1 } }).active, false);
});
