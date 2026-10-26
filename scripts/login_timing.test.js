const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/login-timing.js'), 'utf8');
function fixture({ denied = false, throwingLog = false } = {}) {
  const logs = [], entries = [], memory = new Map(); let clock = 100;
  const window = { performance: { now: () => clock++ }, crypto: { getRandomValues: a => a.fill(clock++ % 255) },
    console: { info(s) { if (throwingLog) throw 1; if(s.startsWith('[YGO login entry timing] '))entries.push(JSON.parse(s.split('[YGO login entry timing] ')[1]));else logs.push(JSON.parse(s.split('[YGO login timing] ')[1])); } },
    sessionStorage: { getItem(k) { if (denied) throw 1; return memory.get(k); }, setItem(k, v) { if (denied) throw 1; memory.set(k, v); }, removeItem(k) { memory.delete(k); } } };
  vm.runInNewContext(source, { window, Uint8Array, Date, Set, Object, Number, Promise, JSON });
  return { api: window.YgoLoginTiming, logs, entries, memory };
}
test('브라우저 계측은 허용 단계/임의 상관 ID만 기록하며 업무 반환·예외·계정 교체 격리를 보존한다', async () => {
  const f = fixture(); const old = f.api.start(), a = f.api.request('getUserData');
  assert.deepEqual(await a.measure('http', () => Promise.resolve({ secret: 'PRIVATE_RESULT' })), { secret: 'PRIVATE_RESULT' });
  const error = { secret: 'PRIVATE_ERROR' }; await assert.rejects(a.measure('id_token', () => Promise.reject(error)), e => e === error);
  a.server('PRIVATE_TOKEN'); a.server('a'.repeat(24)); a.measure('PRIVATE_STAGE', () => 'PRIVATE_VALUE');
  const current = f.api.start(); old.finish('ready'); current.finish('ready');
  assert.equal(f.logs.length, 2); assert.equal(f.logs[0].outcome, 'superseded'); assert.equal(f.logs[1].outcome, 'ready');
  assert.equal(f.logs[0].serverRequests.length, 1); assert(!JSON.stringify(f.logs).includes('PRIVATE'));
  assert.equal(f.api.current(), null); assert.equal(f.api.request('PRIVATE_OPERATION'), null);
});
test('브라우저 저장소/출력 거부·span 상한·중복 종료는 업무를 막지 않는다', async () => {
  for (const options of [{ denied: true }, { throwingLog: true }]) {
    const f = fixture(options); f.api.provider('redirect'); const c = f.api.start();
    assert.equal(await c.measure('http', async () => 42), 42); c.finish('ready'); c.finish('ready');
  }
  const f = fixture(); f.api.provider('redirect'); const c = f.api.start();
  for (let i = 0; i < 120; i++) c.measure('render', () => 1);
  c.finish('ready'); assert.equal(f.logs.length, 1); assert.equal(f.logs[0].spans.length, 96); assert(f.logs[0].droppedSpans > 0);
  assert.equal(f.memory.size, 0); assert.equal(f.logs[0].mode, 'redirect');
});

test('초기 준비 계측은 허용 마크/수치와 고정 요청 분류만 출력하고 URL·쿼리·본문을 남기지 않는다',async()=>{
 const logs=[],events={},memory=new Map();let clock=500;
 const root={location:{origin:'https://example.web.app'},document:{addEventListener:(n,fn)=>events[n]=fn},addEventListener:(n,fn)=>events[n]=fn,
 performance:{now:()=>clock++,getEntriesByType:type=>type==='navigation'?[{responseStart:12,responseEnd:24,domInteractive:40}]:[
  {name:'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=never-log',startTime:11,duration:22,responseStart:0,responseEnd:33},
  {name:'https://example.web.app/script.js?token=never-log',startTime:1,duration:2,responseStart:2,responseEnd:3},
  {name:'https://example.invalid/never-log',startTime:9,duration:9}]},crypto:{getRandomValues:a=>a.fill(1)},
 sessionStorage:{setItem:(k,v)=>memory.set(k,v),getItem:k=>memory.get(k),removeItem:k=>memory.delete(k)},console:{info:s=>logs.push(JSON.parse(s.split('[YGO login timing] ')[1]))}};
 vm.runInNewContext(source,{window:root,URL,Uint8Array,Date,Set,Map,Object,Number,Promise,JSON});
 const api=root.YgoLoginTiming;api.mark('auth_created');api.mark('never-log');events.DOMContentLoaded();await api.startupMeasure('cache',()=>Promise.resolve('never-log'));
 api.provider('redirect');events.pagehide();api.start().finish('ready');
 const row=logs[0];assert.equal(row.version,2);assert.equal(row.startup.scope,'page');assert.equal(row.startup.resources.length,2);assert.equal(row.startup.resources[0].category,'auth_idp');assert.equal(row.startup.resources[0].detailed,false);assert(Number.isFinite(row.navigation.outboundMs));assert.equal(row.startup.navigation.responseStart,12);assert(!JSON.stringify(row).includes('never-log'));
});

test('팝업은 클릭부터 계측하고 이전 페이지의 나이를 로그인 대기로 포함하지 않는다',()=>{
 const f=fixture();f.api.provider('popup');f.api.start().finish('ready');
 assert.equal(f.logs[0].mode,'popup');assert(f.logs[0].spans.some(s=>s.name==='provider_round_trip'));
 assert(!f.logs[0].spans.some(s=>s.name==='page_to_auth_state'));assert.equal(f.memory.size,0);
});
test('팝업 차단 후 redirect는 최초 클릭 시각을 보존하며 취소는 표식을 제거한다',()=>{
 const f=fixture();f.api.provider('popup');const key=[...f.memory.keys()][0],old=JSON.parse(f.memory.get(key));old.at-=1000;f.memory.set(key,JSON.stringify(old));
 f.api.provider('redirect',true);assert.equal(JSON.parse(f.memory.get(key)).at,old.at);assert.equal(JSON.parse(f.memory.get(key)).mode,'redirect');
 f.api.cancelProvider();assert.equal(f.memory.size,0);f.api.start().finish('ready');assert.equal(f.logs[0].mode,'restore');
});

function popupFixture({readonly=false,throwingObserver=false,denied=false}={}) {
 const logs=[],memory=new Map(),resources=[],calls=[];let clock=1000,observerCallback,disconnected=0,timer;
 const root={location:{origin:'https://synthetic.web.app'},performance:{now:()=>clock,getEntriesByType:type=>type==='resource'?resources:[]},crypto:{getRandomValues:a=>a.fill(1)},
 console:{info:s=>logs.push(JSON.parse(s.slice(s.indexOf('] ')+2)))},sessionStorage:{getItem:k=>denied?null:memory.get(k),setItem:(k,v)=>{if(!denied)memory.set(k,v);},removeItem:k=>memory.delete(k)},
 setTimeout:fn=>{timer=fn;return 1;},clearTimeout(){},PerformanceObserver:class {constructor(cb){if(throwingObserver)throw Error('PRIVATE');observerCallback=cb;}observe(){}disconnect(){disconnected++;}takeRecords(){return[];}}};
 const sentinel={private:'PRIVATE_WINDOW'},original=function(...args){calls.push({self:this,args});return sentinel;};
 Object.defineProperty(root,'open',{value:original,writable:!readonly,configurable:true});
 vm.runInNewContext(source,{window:root,URL,Uint8Array,Date,Set,Map,Object,Number,Promise,JSON,Reflect});
 const entry=(category,start,duration)=>({name:`https://identitytoolkit.googleapis.com/v1/accounts:${category}?key=PRIVATE&token=PRIVATE`,startTime:start,duration,responseStart:0});
 return {api:root.YgoLoginTiming,root,logs,calls,original,sentinel,resources,entry,at:n=>clock=n,deliver:()=>observerCallback?.({getEntries:()=>resources}),limit:()=>timer?.(),disconnected:()=>disconnected};
}
test('팝업 계측은 this·인수·반환 객체와 클릭 동기 호출을 보존하고 단계·고정분류만 남긴다',()=>{
 const f=popupFixture();f.api.provider('popup');const t=f.api.beginPopup(),receiver={};f.at(1010);
 assert.equal(f.root.open.call(receiver,'PRIVATE_URL','PRIVATE_TARGET'),f.sentinel);assert.equal(f.calls[0].self,receiver);assert.deepEqual(f.calls[0].args,['PRIVATE_URL','PRIVATE_TARGET']);
 t.returned();f.resources.push(f.entry('signInWithIdp',1100,200),f.entry('lookup',1301,80));f.at(1390);f.deliver();
 const flow=f.api.start();t.settled(true);flow.finish('ready');assert.equal(f.root.open,f.original);assert.equal(f.disconnected(),1);
 const row=f.logs.find(r=>r.event==='login_client_timing'),p=row.popup;assert.equal(p.marks.window_open_call,10);assert.equal(p.marks.auth_state,390);assert.equal(p.marks.sdk_promise_settled,390);assert.equal(p.resources.length,2);assert.equal(p.resources[0].detailed,false);assert(!JSON.stringify(f.logs).includes('PRIVATE'));
});
test('SDK Promise가 Auth 알림보다 먼저 끝나도 같은 팝업을 연결한다',()=>{
 const f=popupFixture();f.api.provider('popup');const t=f.api.beginPopup();t.returned();f.at(1100);t.settled(true);f.at(1120);f.api.start().finish('ready');
 const row=f.logs.find(r=>r.event==='login_client_timing');assert.equal(row.popup.marks.auth_state,120);assert.equal(row.popup.marks.sdk_promise_settled,100);
});
test('팝업 거부·타이머·구간 교체는 관측만 정리하고 다른 구성요소의 open을 덮어쓰지 않는다',()=>{
 const f=popupFixture();f.api.provider('popup');const t=f.api.beginPopup(),other=()=>{};f.root.open=other;t.settled(false);assert.equal(f.root.open,other);t.settled(false);assert.equal(f.logs.length,1);
 const b=popupFixture(),old=b.api.beginPopup();b.api.beginPopup();old.settled(true);assert.equal(b.logs[0].outcome,'superseded');b.limit();assert.equal(b.root.open,b.original);assert.equal(b.logs[1].outcome,'limit');
});
test('관측 불가·저장소 거부·window.open 예외는 기존 결과와 복구를 유지한다',()=>{
 for(const options of [{readonly:true},{throwingObserver:true},{denied:true}]){const f=popupFixture(options);const t=f.api.beginPopup();assert.equal(f.root.open(),f.sentinel);t.returned();t.settled(true);assert.equal(f.root.open,f.original);}
 const f=popupFixture(),error={private:'PRIVATE'};f.root.open=()=>{throw error;};const original=f.root.open,t=f.api.beginPopup();assert.throws(()=>f.root.open(),e=>e===error);t.settled(false);assert.equal(f.root.open,original);assert(!JSON.stringify(f.logs).includes('PRIVATE'));
});
test('시도별 리소스는24개로 제한하고 이전 시도·unknown URL은 포함하지 않는다',()=>{
 const f=popupFixture();f.api.provider('popup');const t=f.api.beginPopup();f.resources.push(f.entry('lookup',1,100),{name:'https://private.invalid/PRIVATE',startTime:1001,duration:1});
 for(let n=0;n<40;n++)f.resources.push(f.entry('lookup',1001+n,1));f.at(2000);f.deliver();t.settled(true);f.api.start().finish('ready');const p=f.logs[0];assert.equal(p.resources.length,24);assert(p.droppedResources>0);assert(!JSON.stringify(p).includes('PRIVATE'));
});
test('Promise 뒤 늦게 등록된 리소스를 회수하고 저장소 거부에서도 현재 팝업을 연결한다',()=>{
 for(const denied of [false,true]){
  const f=popupFixture({denied});f.api.provider('popup');const t=f.api.beginPopup();f.at(1040);t.settled(true);
  assert.equal(f.root.open,f.original);f.resources.push(f.entry('signInWithIdp',1010,20));f.at(1050);f.deliver();
  f.api.start().finish('ready');const row=f.logs.find(r=>r.event==='login_client_timing');assert.equal(row.popup.resources.length,1);assert.equal(f.disconnected(),1);
 }
});


test('진입 시각과 동기화 완료 시각을 같은 흐름으로 기록하고 pending claims의 완료를 만들지 않는다',()=>{
 const f=fixture(),flow=f.api.start();flow.checkpoint('entry_ready');flow.checkpoint('entry_ready');flow.checkpoint('inventory_ready');flow.checkpoint('private-unknown');flow.finish('ready');
 assert.equal(f.entries.length,1);assert.equal(f.entries[0].flowId,f.logs[0].flowId);assert(f.logs[0].entryReadyMs<=f.logs[0].inventoryReadyMs);assert(f.logs[0].inventoryReadyMs<=f.logs[0].totalMs);assert(!Object.hasOwn(f.logs[0],'claimsReadyMs'));assert(!JSON.stringify(f.logs).includes('private-unknown'));
});


test('SDK 갱신 전후 리소스 분류는 URL이나 버전을 출력하지 않고 동일한 계측 범주를 유지한다',()=>{
 const logs=[],root={console:{info:s=>logs.push(JSON.parse(s.split('[YGO login timing] ')[1]))},performance:{now:()=>1,getEntriesByType:t=>t==='resource'?['10.12.0','13.0.0'].flatMap(v=>['app','auth','app-check'].map((n,i)=>({name:`https://synthetic.test/__/firebase/${v}/firebase-${n}-compat.js?private=never-log`,startTime:i,duration:1,responseStart:0,responseEnd:i+1}))):[]},crypto:{getRandomValues:a=>a.fill(1)}};
 vm.runInNewContext(source,{window:root,URL,Uint8Array,Date,Set,Map,Object,Number,Promise,JSON});
 root.YgoLoginTiming.start().finish('ready');const rows=logs[0].startup.resources;assert.equal(rows.length,6);assert.deepEqual(Array.from(rows,r=>r.category),['sdk_app','sdk_auth','sdk_app_check','sdk_app','sdk_auth','sdk_app_check']);assert(!JSON.stringify(rows).includes('never-log'));
});
