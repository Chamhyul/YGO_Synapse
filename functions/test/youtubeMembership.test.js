const test = require('node:test');
const assert = require('node:assert/strict');
const { createYoutubeMembershipHandlers, getOwnedYoutubeChannel } = require('../services/youtubeMembership');
const { forwardYoutubeMembership } = require('../services/youtubeMembershipTransport');
const channel = 'UC' + 'a'.repeat(22);
function fixture({ local = false, app = true, uid = 'user-a', googleStatus = 200, role = null, fetchError = false } = {}) {
  const records = new Map([['membership_csv_users/' + channel, { levelName: '회원' }]]);
  let time = 10000, googleCalls = 0, localForward = [], lock = Promise.resolve();
  const snapshot = ref => ({ exists: records.has(ref.path), data: () => records.get(ref.path) });
  const db = { collection: name => ({ doc: id => ({ path: `${name}/${id}`, get: async function(){ return snapshot(this); },
    set: async function(value){ records.set(this.path, value); } }) }),
    runTransaction: fn => {
      const run = lock.then(() => fn({ get: async ref => snapshot(ref), set: (ref, data) => records.set(ref.path, data),
        update: (ref, data) => records.set(ref.path, { ...records.get(ref.path), ...data }) }));
      lock = run.catch(() => {}); return run;
    } };
  const handlers = createYoutubeMembershipHandlers({ db, auth: { getUser: async () => ({ customClaims: { role } }) },
    now: () => time, isLocal: () => local, setCors(){},
    verifyAppCheck: async (_, res) => { if (!app) res.status(401).json({ success: false }); return app; },
    verifyRegisteredUser: async req => req.uid || uid,
    fetchImpl: async (_, options) => { googleCalls++; assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer temporary-google-token');
      if (fetchError) throw Error('SECRET-TOKEN');
      return { ok: googleStatus === 200, status: googleStatus, json: async () => ({ items: [{ id: channel }] }) }; },
    forward: async (op, body) => { localForward.push({op,body}); return { success: true, uid, verificationId: 'f'.repeat(64),
      membership: { status: 'active', type: 'account', levelName: '관리자' },
      sourceMembership: { status: 'active', userChannelId: channel, type: 'csv', verificationVersion: 2, verificationProvider: 'youtube' }, isMemberActive: true }; }
  });
  async function call(name, body = {}, extra = {}) {
    const res = { statusCode: 200, set(){return this;}, status(n){this.statusCode=n;return this;}, json(data){this.body=data;return this;}, send(){return this;} };
    await handlers[name]({ method: 'POST', body, query: {}, headers: {}, ...extra }, res); return res;
  }
  return { call, records, advance: ms => time += ms, googleCalls: () => googleCalls, localForward };
}
const start = async f => (await f.call('startYoutubeMembershipVerification')).body.verificationId;
const complete = (f, id, extra) => f.call('verifyYoutubeMembership', { verificationId: id, accessToken: 'temporary-google-token' }, extra);
test('Google가 확인한 채널만 CSV와 비교하고 운영 사용자에게 저장한다', async () => {
  const f = fixture(), id = await start(f); const res = await complete(f, id);
  assert.equal(res.statusCode, 200); assert.equal(res.body.membership.userChannelId, channel);
  assert.equal(res.body.membership.status, 'active'); assert.equal(f.records.get('users/user-a').settings.membership.status, 'active');
  assert.ok(!JSON.stringify([...f.records]).includes('temporary-google-token'));
});
test('채널 ID만 제출하는 구버전 요청은 저장과 Google 호출 전에 거부한다', async () => {
  const f = fixture(); const res = await f.call('verifyYoutubeMembership', { userChannelId: channel });
  assert.equal(res.statusCode, 400); assert.equal(f.googleCalls(), 0); assert.equal(f.records.has('users/user-a'), false);
});
test('다른 서비스 계정·만료·재사용·동시 재사용은 거부한다', async () => {
  const f = fixture(), id = await start(f);
  assert.equal((await complete(f, id, { uid: 'user-b' })).statusCode, 403);
  const results = await Promise.all([complete(f, id), complete(f, id)]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200,403]); assert.equal(f.googleCalls(), 1);
  assert.equal((await complete(f, id)).statusCode, 403);
  f.advance(4000); const next = await start(f); f.advance(300001);
  assert.equal((await complete(f, next)).statusCode, 403);
});
test('새 인증을 시작하면 이전 인증이 무효화되고 시작 빈도를 제한한다', async () => {
  const f = fixture(), id = await start(f);
  assert.equal((await f.call('startYoutubeMembershipVerification')).statusCode, 429);
  f.advance(3001); await start(f); assert.equal((await complete(f, id)).statusCode, 403);
});
test('App Check 실패와 GET 요청은 사용자 데이터에 접근하지 않는다', async () => {
  const f = fixture({app:false}); assert.equal((await f.call('startYoutubeMembershipVerification')).statusCode, 401);
  assert.equal(f.records.size, 1);
  assert.equal((await fixture().call('startYoutubeMembershipVerification', {}, {method:'GET'})).statusCode, 405);
});
test('Google 인증 실패·장애는 멤버십을 저장하지 않으며 토큰을 응답하지 않는다', async () => {
  for(const options of [{googleStatus:401},{googleStatus:403},{fetchError:true}]) {
    const f = fixture(options), id = await start(f), res = await complete(f,id);
    assert.ok([401,403,503].includes(res.statusCode)); assert.equal(f.records.has('users/user-a'), false);
    assert.ok(!JSON.stringify(res.body).includes('SECRET-TOKEN'));
  }
});
test('CSV에 없는 채널은 일반 회원이며 관리자 판단은 현재 Auth Claims를 사용한다', async () => {
  const f = fixture(); f.records.delete('membership_csv_users/'+channel);
  assert.equal((await complete(f, await start(f))).body.membership.status, 'none');
  const owner = fixture({role:'owner'}); owner.records.delete('membership_csv_users/'+channel);
  const result = await complete(owner, await start(owner));
  assert.equal(result.body.membership.levelName, '소유자');
  assert.equal(result.body.sourceMembership.status, 'none');
  assert.equal(owner.records.get('users/user-a').settings.membership.status, 'none');
});
test('로컬 검증은 운영 결과를 받아 로컬에만 저장하고 시작 시 저장 대상을 고정한다', async () => {
  const operating = fixture(); const id = (await operating.call('startYoutubeMembershipVerification', {localOnly:true})).body.verificationId;
  await complete(operating,id); assert.equal(operating.records.has('users/user-a'), false);
  const local = fixture({local:true}); const localId = await start(local); await complete(local,localId);
  assert.equal(local.googleCalls(),0); assert.equal(local.localForward.every(r => r.body.localOnly === true),true);
  assert.equal(local.records.get('users/user-a').settings.membership.status,'active');assert.equal(local.records.get('users/user-a').settings.membership.type,'csv');
});
test('YouTube 응답이 비정상·여러 채널이면 임의로 첫 채널을 선택하지 않는다', async () => {
  for(const items of [[],[{id:'bad'}],[{id:channel},{id:channel}]]) {
    await assert.rejects(getOwnedYoutubeChannel('t', async () => ({ok:true,json:async()=>({items})})), e => e.code === 'YOUTUBE_CHANNEL_REQUIRED');
  }
});
test('로컬 전달은 고정 URL·로그인·App Check를 사용하고 리디렉션을 금지한다', async () => {
  let count = 0;
  const fetchImpl = async (url, options) => { count++; assert.equal(url, 'https://asia-northeast3-ygo-synapse.cloudfunctions.net/verifyYoutubeMembership');
    assert.equal(options.redirect,'error'); assert.equal(options.headers.Authorization,'Bearer main-token');
    return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({success:true,uid:'user-a'})}; };
  await assert.rejects(forwardYoutubeMembership('other',{}, {},fetchImpl));
  await assert.rejects(forwardYoutubeMembership('verifyYoutubeMembership',{}, {},fetchImpl)); assert.equal(count,0);
  await forwardYoutubeMembership('verifyYoutubeMembership',{}, {authorization:'Bearer main-token','x-firebase-appcheck':'app-token'},fetchImpl);
  assert.equal(count,1);
});
test('과거 CSV 멤버십은 재인증하도록 반환하고 검증 완료·Discord 설정은 유지한다', () => {
  const { sanitizeYoutubeMembership } = require('../services/youtubeMembership');
  const old = {theme:'dark',membership:{status:'active',type:'csv',userChannelId:channel}};
  assert.equal(sanitizeYoutubeMembership(old).membership.status,'none'); assert.equal(old.membership.status,'active');
  assert.equal(sanitizeYoutubeMembership(old).theme,'dark');
  const fresh={membership:{status:'active',type:'csv',verificationVersion:2,verificationProvider:'youtube'}};
  assert.deepEqual(sanitizeYoutubeMembership(fresh).membership,{...fresh.membership,levelName:'유튜브 멤버십'});
  const discord={membership:{status:'active',type:'discord'}};assert.equal(sanitizeYoutubeMembership(discord),discord);
});
test('잘못된 입력과 헤더 주입용 토큰은 Google 호출 전에 거부한다', async () => {
  const f=fixture();
  for(const body of ['text', [], {accessToken:'token\r\nInjected: x',verificationId:'a'.repeat(64)}, {accessToken:'t',verificationId:'bad'}]) {
    assert.equal((await f.call('verifyYoutubeMembership',body)).statusCode,400);
  }
  assert.equal(f.googleCalls(),0);assert.equal(f.records.has('users/user-a'),false);
});
test('구버전 채널 ID API는 인증정보·CSV·사용자 저장소를 읽지 않고 거부한다', async () => {
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../routes/integration.js'),'utf8');
  const begin=source.indexOf('exports.checkMembershipCsv = '),end=source.indexOf('/**',begin);
  const ctx={exports:{},onRequest:(_,fn)=>fn,setCors(){}};
  vm.runInNewContext(source.slice(begin,end),ctx);
  const res={statusCode:200,set(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
  await ctx.exports.checkMembershipCsv({method:'POST',body:{userChannelId:channel}},res);
  assert.equal(res.statusCode,410);assert.equal(res.body.success,false);
});
