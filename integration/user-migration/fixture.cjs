'use strict';
const { randomBytes, createHash } = require('node:crypto');
const load = require('node:module').createRequire(require('node:path').resolve(__dirname, '../../functions/package.json'));
const { Timestamp } = load('firebase-admin/firestore');
const { newKey } = require('../../card-service/src/services/cardApiAccess');
const { createFirestoreMembershipCsvStore, createMembershipCsvService } = require('../../functions/services/membershipCsvService');
const { fingerprint } = require('../../functions/services/userMigrationRehearsal');
const sha = text => createHash('sha256').update(text).digest('hex');
async function seed(connection) {
  const now = Date.now(), uid = `synthetic-${randomBytes(6).toString('hex')}`, other = `${uid}-inventory`, owner = `${uid}-owner`;
  const { db, bucket, auth } = connection;
  const authOnly = `${uid}-authonly`;
  for (const id of [uid, other, owner, authOnly]) await auth.createUser({ uid: id });
  await auth.setCustomUserClaims(owner, { role: 'owner', admin: true, retain: 'synthetic' });
  const membership = { status: 'active', type: 'discord', levelName: '합성 회원', discordId: '123456789012345678', verificationVersion: 2, verificationProvider: 'discord', lastChecked: now };
  await db.collection('users').doc(uid).set({ Nickname: '합성', createdAt: new Timestamp(1700000000, 123456789),
    settings: { theme: 'dark', membership, nested: { empty: {}, array: [null, 'A'], missing: null } },
    registration: { version: 1, consent: { termsVersion: 'synthetic-version', privacyVersion: 'synthetic-version', acceptedAt: new Timestamp(1700000000, 987654321) } } });
  await db.collection('users').doc(owner).set({ settings: { theme: 'light' } });
  const inventory = { version: 3, updatedAt: '2026-10-01T00:00:00.000Z', amount: 2,
    locations: { '상자.[A]': 2 }, rarities: { '레어.★': 2 },
    cards: { 'KOREA-A01': { name: '합성 카드', cid: null, cidCheckedAt: 'synthetic-check', items: [{ rarity: '레어.★', qty: 2, loc: '상자.[A]', illustration: '01' }] } } };
  for (const id of [uid, other]) await bucket.file(`users/${id}/inventory.json`).save(JSON.stringify(id === other ? { ...inventory, version: 1 } : inventory), { resumable: false, contentType: 'application/json' });
  const nonceHash = sha('synthetic-proof');
  await db.collection('youtube_membership_verifications').doc(uid).set({ nonceHash, startedAt: now, expiresAt: now + 300000, consumed: false, localOnly: false });
  await db.collection('discord_membership_verifications').doc(other).set({ nonceHash, startedAt: now - 600000, expiresAt: now - 300000, consumed: true, localOnly: true, redirectUri: 'http://localhost:5005/' });
  const session = sha(`session:${uid}`), expiredSession = sha(`expired:${uid}`);
  await db.collection('AdminWebSessions').doc(session).set({ uid: owner, lastActivity: now, expiresAt: now + 3600000 });
  await db.collection('AdminWebSessions').doc(expiredSession).set({ uid: owner, lastActivity: now - 4000000, expiresAt: now - 1000 });
  const key = newKey(), disabledKey = newKey();
  for (const [value, enabled] of [[key, true], [disabledKey, false]]) {
    await db.collection('cardApiKeys').doc(value.id).set({ label: '합성 키', origins: ['https://synthetic.invalid'], minuteLimit: 'unlimited', dayLimit: 100,
      expiresAt: null, scope: 'getCardInfo', enabled, secretHash: value.secretHash, createdAt: now - 100000 });
  }
  await db.collection('cardApiUsage').doc(key.id).set({ minute: Math.floor(now / 60000), day: Math.floor(now / 86400000), minuteCount: 2, dayCount: 4 });
  await db.collection('cardApiConfig').doc('cors').set({ keyOrigins: { [key.id]: ['https://synthetic.invalid'] } });
  const csv = createMembershipCsvService({ store: createFirestoreMembershipCsvStore(db) }), csvId = randomBytes(16).toString('hex');
  // 파일의 등급 순서와 Firestore 채널 정렬이 달라도 기존 결과 배열을 보존해야 한다.
  const members = [{ channelId: 'UC' + 'z'.repeat(22), memberName: '합성 Z', levelName: '등급 Z' }, { channelId: 'UC' + 'a'.repeat(22), memberName: '합성 A', levelName: '등급 A' }];
  const preview = await csv.preview({ members }); await csv.apply({ members, ...preview, operationId: csvId }, owner);
  await db.collection('membership_csv_users').doc('UC' + 'l'.repeat(22)).set({ channelId: 'UC' + 'l'.repeat(22), memberName: '구형 합성', levelName: '구형' });
  const failedId = randomBytes(16).toString('hex');
  await db.collection('membership_csv_imports').doc(failedId).set({ actor: owner, binding: sha('synthetic-failed'), startedAt: now - 200000, status: 'failed' });
  await db.collection('membership_csv_imports').doc(failedId).collection('members').doc(members[0].channelId).set(members[0]);
  await db.collection('cards').doc('synthetic-card').set({ cid: 'synthetic-card', ko: { name: '합성 카드' } });
  await db.collection('system').doc('crawler').set({ enabled: false, epoch: 'synthetic-epoch' });
  for (const name of ['notice/notices.json', 'illustrations/synthetic.webp', 'models/synthetic.bin']) await bucket.file(name).save(`synthetic-retained:${name}`, { resumable: false });
  return { uid, other, owner, authOnly, now, inventory, nonceHash, session, expiredSession, key, disabledKey, csvId, members, failedId };
}
async function retained(connection, fixture) {
  const { db, bucket, auth } = connection, result = {};
  for (const name of ['cards/synthetic-card', 'system/crawler']) { const [collection, id] = name.split('/'); result[name] = (await db.collection(collection).doc(id).get()).data(); }
  for (const name of ['notice/notices.json', 'illustrations/synthetic.webp', 'models/synthetic.bin']) { const [bytes] = await bucket.file(name).download(); const [metadata] = await bucket.file(name).getMetadata(); result[name] = { hash: sha(bytes), generation: String(metadata.generation) }; }
  for (const uid of [fixture.uid, fixture.other, fixture.owner, fixture.authOnly]) {
    const account = await auth.getUser(uid), { ygoMembership, ...claims } = account.customClaims || {};
    result[uid] = { uid: account.uid, disabled: account.disabled, claims };
  }
  return fingerprint(result);
}
module.exports = { seed, retained };
