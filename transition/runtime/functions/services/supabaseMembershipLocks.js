'use strict';

function lockRoster(client, shared = false) {
  return client.query(shared ? "select pg_advisory_xact_lock_shared(hashtextextended('app.youtube_roster',0))"
    : "select pg_advisory_xact_lock(hashtextextended('app.youtube_roster',0))");
}

function lockClaims(client, uid) {
  return client.query("select pg_advisory_xact_lock(hashtextextended('app.membership_claims:' || $1,0))", [uid]);
}

function lockMembershipVerification(client, uid) {
  // 명단 잠금 결과를 읽은 뒤 UID 잠금을 얻는다.
  return client.query(`with roster_lock as materialized (
    select pg_advisory_xact_lock_shared(hashtextextended('app.youtube_roster',0))
  )
  select pg_advisory_xact_lock(hashtextextended('app.membership_claims:' || $1,0)) from roster_lock`, [uid]);
}

module.exports = { lockRoster, lockClaims, lockMembershipVerification };
