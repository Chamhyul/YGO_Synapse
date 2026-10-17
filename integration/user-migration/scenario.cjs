'use strict';
const { randomBytes, createHash } = require('node:crypto');
const { open } = require('./connection.cjs');
const { seed, retained } = require('./fixture.cjs');
const { createLegacy, createDestination } = require('./adapters.cjs');
const { createRecordStore } = require('../../functions/services/user-storage/recordStore');
const { createUserMigrationRehearsal } = require('../../functions/services/userMigrationRehearsal');
const { createProfileStore } = require('../../functions/services/user-storage/profileStore');
const { createAdminSessionStore } = require('../../functions/services/user-storage/adminSessionStore');
const { createApiAccessStore } = require('../../functions/services/user-storage/apiAccessStore');
const { createMembershipStore } = require('../../functions/services/user-storage/membershipStore');
const { createCustomClaimsStore } = require('../../functions/services/user-storage/customClaimsStore');
const { syncMembershipClaims } = require('../../functions/services/membershipClaims');
const { createMembershipCsvStore } = require('../../functions/services/user-storage/membershipCsvStore');
const { createMembershipCsvService } = require('../../functions/services/membershipCsvService');
const { newKey } = require('../../card-service/src/services/cardApiAccess');
async function setup(options = {}, resumed) {
  const runId = resumed?.runId || randomBytes(16).toString('hex'), connection = open(runId);
  try {
    const fixture = resumed?.fixture || await seed(connection), source = createLegacy(connection);
    const journal = createRecordStore({ database: connection.database, path: 'migrationJournal' });
    const plan = resumed ? (await journal.read(runId)).value.source : await source.snapshot();
    const target = createDestination(connection, plan, runId);
    const tool = createUserMigrationRehearsal({ source, target, journal, ...options });
    const csvStore = createMembershipCsvStore({ database: target.database });
    const runtime = { profile: createProfileStore({ database: target.database }),
      membership: createMembershipStore({ database: target.database }),
      customClaims: createCustomClaimsStore({ database: target.database }),
      sessions: createAdminSessionStore({ database: target.database }),
      api: createApiAccessStore({ database: target.database, clock: () => fixture.now }),
      csvStore, csv: createMembershipCsvService({ store: csvStore }), inventory: target.inventory };
    return { runId, connection, fixture, source, target, journal, tool, runtime, retained: () => retained(connection, fixture), close: () => connection.close() };
  } catch (error) { await connection.close(); throw error; }
}
async function changes(context) {
  const { fixture: f, runtime: r } = context;
  await r.profile.update(f.uid, { Nickname: '수정된 합성', settings: { theme: 'light' } });
  const profileRepository = require('../../functions/services/userProfileRepository').createRtdbUserProfileRepository({ storage: { profile: r.profile, inventory: r.inventory } });
  const version = createHash('sha256').update('synthetic-consent').digest('hex');
  await profileRepository.completeRegistration(f.authOnly, { terms: version, privacy: version });
  await r.profile.update(f.authOnly, { Nickname: '신규 합성', settings: { theme: 'dark' } });
  await r.inventory.update(f.uid, data => { data.cards['KOREA-A01'].items[0].qty = 5; data.amount = 5; data.locations['상자.[A]'] = 5; data.rarities['레어.★'] = 5; });
  await r.inventory.clear(f.other);
  await r.inventory.update(f.owner, data => { Object.assign(data, f.inventory); });
  await r.membership.consume(f.uid, 'youtube', f.nonceHash, f.now + 1);
  await r.membership.complete(f.uid, 'youtube', f.nonceHash, { status: 'active', type: 'csv', levelName: '등급 A', userChannelId: f.members[1].channelId, verificationVersion: 2, verificationProvider: 'youtube', lastChecked: f.now + 2 }, f.now + 2);
  const synced = await syncMembershipClaims(f.uid, { env: process.env, storage: { ...r, config: context.connection.config }, auth: context.connection.auth, allowEmulator: true });
  if (synced.status !== 'synced') throw Object.assign(new Error(), { code: 'MIGRATION_AUTH_WRITE_UNRESOLVED' });
  await r.sessions.touch(f.session, f.owner, f.now + 1000); await r.sessions.remove(f.expiredSession);
  const newSession = createHash('sha256').update('synthetic-new-session').digest('hex');
  await r.sessions.set(newSession, { uid: f.owner, lastActivity: f.now, expiresAt: f.now + 100000 });
  await r.api.consume(f.key.token, 'https://synthetic.invalid');
  const rotated = newKey(f.key.id); await r.api.rotate(rotated);
  const additional = newKey(); await r.api.register(additional, { label: '추가 합성', origins: ['https://new.synthetic.invalid'], minuteLimit: 5, dayLimit: 'unlimited' });
  await r.api.disable(f.disabledKey.id);
  const members = [{ channelId: 'UC' + 'n'.repeat(22), memberName: '전환 뒤 합성', levelName: '새 등급' }];
  await r.csv.apply({ members, ...await r.csv.preview({ members }), operationId: randomBytes(16).toString('hex') }, f.owner);
  const nextMembers = [{ channelId: 'UC' + 'o'.repeat(22), memberName: '다음 합성', levelName: '새 등급' }];
  await r.csv.apply({ members: nextMembers, ...await r.csv.preview({ members: nextMembers }), operationId: randomBytes(16).toString('hex') }, f.owner);
  const failedId = randomBytes(16).toString('hex'), revision = (await r.csvStore.read()).revision;
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  await r.csvStore.begin(failedId, digest([f.owner, revision, digest(members)]), revision, f.owner, Date.now());
  await r.csvStore.stage(failedId, members); await r.csvStore.fail(failedId);
  return { rotated, additional };
}
async function run() {
  const context = await setup();
  try {
    const retainedBefore = await context.retained();
    const copied = await context.tool.copy(context.runId);
    const activated = await context.tool.activate(context.runId, { writersDrained: true });
    await changes(context);
    const rolledBack = await context.tool.rollback(context.runId, { writersDrained: true });
    if (retainedBefore !== await context.retained()) throw Object.assign(new Error(), { code: 'MIGRATION_RETAINED_CHANGED' });
    return { copied, activated, rolledBack, retainedUnchanged: true };
  } finally { await context.close(); }
}
module.exports = { setup, changes, run };
