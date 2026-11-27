'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { lockMembershipVerification } = require('./supabaseMembershipLocks');
const { dispatchCommittedMembershipClaims } = require('./supabaseMembershipClaimsDispatch');
const { DISCORD_REDIRECTS } = require('../integrations/discordMembership');

const proofField = { discord: 'code', youtube: 'accessToken' };
const accountPatterns = { discord: /^\d{17,20}$/, youtube: /^UC[A-Za-z0-9_-]{22}$/ };
const lifetimeMs = 300000;
const cooldownMs = 3000;
const fail = (code, status) => Object.assign(new Error(code), { status });
const digest = value => createHash('sha256').update(value).digest('hex');
const expired = () => fail('MEMBERSHIP_VERIFICATION_EXPIRED', 403);

async function membershipRegistered(client) {
  return (await client.query('select app.membership_registered() as registered')).rows[0]?.registered === true;
}

function createMembershipVerification({ database, providers, now = Date.now, enqueueClaims }) {
  function writeNonce(uid, sql, values) {
    if (database.writeMembershipNonce) return database.writeMembershipNonce(uid,sql,values);
    return database.withUser(uid,client=>client.query(sql,values));
  }

  function adapterFor(provider) {
    const adapter = providers[provider];
    if (typeof adapter?.verify !== 'function' || (provider === 'discord' && typeof adapter.authorizationUrl !== 'function')) {
      throw fail('MEMBERSHIP_PROVIDER_UNAVAILABLE', 503);
    }
    return adapter;
  }

  async function start(uid, provider, body, { redirectUri } = {}) {
    const adapter = adapterFor(provider);
    if (Object.keys(body).length) throw fail('INVALID_COMMAND', 400);
    await adapter.ready?.();
    const verificationId = randomBytes(32).toString('hex');
    if (redirectUri !== undefined && (provider !== 'discord' || !DISCORD_REDIRECTS.has(redirectUri))) throw fail('DISCORD_REDIRECT_INVALID', 400);
    const authorizationUrl = provider === 'discord' ? adapter.authorizationUrl(verificationId,redirectUri) : undefined;
    const startedAt = now();
    const started = await writeNonce(uid, `
      insert into app.membership_verifications (user_id,provider,nonce_hash,started_at,expires_at,phase,redirect_uri)
      values ($1,$2,$3,$4,$5,'pending',$7)
      on conflict (user_id) do update set provider=excluded.provider,nonce_hash=excluded.nonce_hash,
        started_at=excluded.started_at,expires_at=excluded.expires_at,phase='pending',
        redirect_uri=excluded.redirect_uri
      where app.membership_verifications.started_at <= $6`,
    [uid,provider,digest(verificationId),startedAt,startedAt+lifetimeMs,startedAt-cooldownMs,redirectUri ?? null]);
    if (!started.rowCount) throw fail('MEMBERSHIP_TOO_MANY_REQUESTS', 429);
    return { verificationId, ...(authorizationUrl ? { authorizationUrl } : {}) };
  }

  async function verify(uid, provider, body, prepareAccount, { includeSource = false, onCommitted } = {}) {
    const adapter = adapterFor(provider);
    const field = proofField[provider];
    const { verificationId, [field]: proof, ...extra } = body;
    const maxLength = provider === 'discord' ? 2048 : 8192;
    if (Object.keys(extra).length || typeof verificationId !== 'string' || !/^[a-f0-9]{64}$/.test(verificationId)
        || typeof proof !== 'string' || !proof || proof.length > maxLength || /[\r\n]/.test(proof)) {
      throw fail('INVALID_COMMAND', 400);
    }
    const nonceHash = digest(verificationId);
    const consumed = await writeNonce(uid, `
      update app.membership_verifications set phase='consumed'
      where user_id=$1 and provider=$2 and nonce_hash=$3 and expires_at>$4 and phase='pending'
      returning redirect_uri`,
    [uid,provider,nonceHash,now()]);
    if (!consumed.rowCount) throw expired();

    // 외부 검증은 DB 잠금 밖에서 실행한다. 브라우저가 제출한 회원 정보는 받지 않는다.
    // 서명 확인과 제공자 응답은 독립적이다. 최신 계정 조회는 잠금 획득 후 실행한다.
    const [result, recheckAccount] = await Promise.all([
      adapter.verify(proof, consumed.rows[0].redirect_uri ?? undefined),
      prepareAccount(),
    ]);
    const { accountId, status, levelName = null } = result || {};
    if (typeof accountId !== 'string' || !accountPatterns[provider].test(accountId) ||
        !['active','none'].includes(status) || (status === 'active' &&
          (typeof levelName !== 'string' || !levelName.trim() || levelName.length > 200))) {
      throw fail('MEMBERSHIP_PROVIDER_UNAVAILABLE', 503);
    }
    const membership = { provider, status, levelName:status === 'active' ? levelName : null };
    const { account, membershipRow } = await database.withUser(uid, async client => {
      await lockMembershipVerification(client, uid);
      const account = await recheckAccount();
      if (!await membershipRegistered(client)) throw fail('REGISTRATION_REQUIRED', 403);
      await adapter.confirm?.(client,result);
      const { rows: [membershipRow] } = await client.query(`
        with completed as (
          update app.membership_verifications set phase='completed'
          where user_id=$1 and provider=$2 and nonce_hash=$3 and expires_at>$4 and phase='consumed'
          returning user_id
        ), saved as (
          insert into app.user_memberships (user_id,provider,provider_account_id,status,level_name)
          select user_id,$2,$5,$6,$7 from completed
          on conflict (user_id) do update set provider=excluded.provider,provider_account_id=excluded.provider_account_id,
            status=excluded.status,level_name=excluded.level_name
          returning user_id,provider,status,level_name,provider_account_id
        ), queued as (
          insert into app.membership_claims_pending(user_id) select user_id from saved on conflict do nothing
        )
        select provider,status,level_name,provider_account_id from saved`,
      [uid,provider,nonceHash,now(),accountId,status,membership.levelName]);
      if (!membershipRow) throw expired();
      return { account, membershipRow };
    });
    try {
      onCommitted?.({ account, membershipRow });
    } finally {
      await dispatchCommittedMembershipClaims(uid, enqueueClaims);
    }
    return { membership, claimsPending:true, membershipClaims:{status:'pending'},
      ...(includeSource ? { account, membershipRow, sourceMembership: { status, type:provider==='youtube'?'csv':provider,
        levelName:membership.levelName || '일반', [provider==='youtube'?'userChannelId':'discordId']:accountId,
        verificationVersion:2, verificationProvider:provider, lastChecked:now() } } : {}) };
  }

  return { start, verify };
}

module.exports = { createMembershipVerification, membershipRegistered };
