'use strict';
function configuration(env = process.env) {
  const mode = env.TRANSITION_AUTH_MODE || 'firebase';
  const environment = env.TRANSITION_ENV || 'production';
  if (!['local', 'test', 'preview', 'production'].includes(environment)) throw Error('전환 API 환경을 확인해 주세요.');
  const production = environment === 'production';
  const databaseRole = production ? 'synapse_transition_prod' : 'synapse_transition_api';
  if (!['demo', 'firebase'].includes(mode) || !env.DATABASE_URL) throw Error('전환 API 설정이 필요합니다.');
  if (mode === 'demo' && !['local', 'test', 'preview'].includes(env.TRANSITION_ENV)) throw Error('샘플 인증은 시험 환경에서만 허용합니다.');
  if(mode==='demo'&&env.TRANSITION_ENV==='preview'&&(!env.TRANSITION_SESSION_SECRET||env.TRANSITION_SESSION_SECRET.length<32))throw Error('시험 세션 서명 설정이 필요합니다.');
  if (mode === 'firebase' && !env.FIREBASE_PROJECT_ID) throw Error('Firebase 프로젝트를 지정해야 합니다.');
  let database;try{database=new URL(env.DATABASE_URL);}catch(_){throw Error('DB 연결 주소 형식을 확인해야 합니다.');}
  if (!['postgres:', 'postgresql:'].includes(database.protocol) ||
      !new RegExp(`^${databaseRole}(?:\\.[a-z0-9]{20})?$`).test(database.username)) {
    throw Error('제한된 전환 API 전용 DB 계정을 사용해야 합니다.');
  }
  if (!['local','test'].includes(environment)) {
    const project=env.SUPABASE_PROJECT_REF;
    const direct=project&&database.hostname===`db.${project}.supabase.co`&&database.username===databaseRole;
    const pooled=project&&database.hostname.endsWith('.pooler.supabase.com')&&database.username===`${databaseRole}.${project}`;
    const sslMode=database.searchParams.get('sslmode');
    const tls=production ? sslMode==='verify-full' && database.searchParams.size===1
      : ['require','verify-full'].includes(sslMode);
    if(!/^[a-z0-9]{20}$/.test(project||'')||(!direct&&!pooled)||!tls) throw Error('대상 Supabase 프로젝트와 TLS 연결을 확인해야 합니다.');
  }
  const membershipDatabaseUrl=env.TRANSITION_MEMBERSHIP_DATABASE_URL;
  if(membershipDatabaseUrl){
    let writer;try{writer=new URL(membershipDatabaseUrl);}catch(_){throw Error('멤버십 DB 연결 주소를 확인해 주세요.');}
    if(mode!=='firebase' || writer.protocol!==database.protocol || writer.hostname!==database.hostname ||
      writer.port!==database.port || writer.pathname!==database.pathname ||
      !/^synapse_membership_api(?:\.[a-z0-9]{20})?$/.test(writer.username) ||
      (production && writer.searchParams.size!==1) ||
      (!['local','test'].includes(environment) && writer.searchParams.get('sslmode')!==database.searchParams.get('sslmode'))) {
      throw Error('같은 DB의 멤버십 전용 연결을 확인해 주세요.');
    }
  }
  const discord=env.TRANSITION_DISCORD_REDIRECT_URI ? {
    redirectUri:env.TRANSITION_DISCORD_REDIRECT_URI,clientId:env.DISCORD_CLIENT_ID,
    clientSecret:env.DISCORD_CLIENT_SECRET,guildId:env.DISCORD_GUILD_ID,
  } : null;
  return { mode, environment, databaseRole, databaseUrl: env.DATABASE_URL, membershipDatabaseUrl,discord,
    projectId: env.FIREBASE_PROJECT_ID, port: Number(env.PORT || 8080),
    sessionSecret:env.TRANSITION_SESSION_SECRET,artworkBucket:env.TRANSITION_ARTWORK_BUCKET,webRoot: env.TRANSITION_WEB_ROOT || '/app/web', poolMax: 4 };
}
module.exports = { configuration };
