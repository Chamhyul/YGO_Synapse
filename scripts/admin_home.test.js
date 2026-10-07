const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source=fs.readFileSync('public/admin-home.js','utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function node() {return {hidden:false,disabled:false,textContent:'',children:[],events:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;},replaceChildren(...items){this.children=items;},append(...items){this.children.push(...items);},addEventListener(k,v){this.events[k]=v;}};}
function fixture({status=200,data={},pending,hidden=false}={}) {
  const nodes=new Map(['admin-content','admin-errors-list','admin-errors-status','admin-error-count','admin-error-groups','admin-errors-source','admin-errors-refresh'].map(id=>[id,node()]));
  nodes.get('admin-content').hidden=hidden; const calls=[];
  vm.runInNewContext(source,{document:{getElementById:id=>nodes.get(id),createElement:node},Intl,AbortController,setTimeout,clearTimeout,
    window:{location:{reload(){calls.push('reload');}}},fetch:async(url,options)=>{calls.push({url,options});if(pending)await pending;return{status,ok:status===200,json:async()=>data};}});
  return {nodes,calls};
}
const base={success:true,occurrenceCount:12,groupCount:2,topErrors:[{description:'<img src=x onerror=alert(1)>',feature:'카드 데이터 처리',count:9,lastSeen:'2026-10-07T00:00:00Z'}],periodStart:'2026-10-06T00:00:00Z',queriedAt:'2026-10-07T00:00:00Z'};
test('로딩에서는 값을 비우고 완료 후 실제 건수·한국 시각·목록을 표시한다',async()=>{
  let done;const f=fixture({data:base,pending:new Promise(r=>{done=r;})});
  assert.equal(f.nodes.get('admin-error-count').textContent,'—');assert.equal(f.nodes.get('admin-errors-refresh').disabled,true);
  done();await settle();assert.equal(f.nodes.get('admin-error-count').textContent,'12');assert.equal(f.nodes.get('admin-error-groups').textContent,'2');
  const row=f.nodes.get('admin-errors-list').children[0]; assert.equal(row.children[1].children[0].textContent,base.topErrors[0].description);
  assert.equal(row.children[1].children[0].innerHTML,undefined);assert.match(f.nodes.get('admin-errors-source').textContent,/한국 시간/);
  assert.equal(f.calls[0].url,'/admin/api/errors');assert.equal(f.calls[0].options.credentials,'same-origin');
});
test('수집0건·API실패·일부 합계 상태를 구분하고 실패 후 재시도할 수 있다',async()=>{
  const empty=fixture({data:{...base,occurrenceCount:0,groupCount:0,topErrors:[]}});await settle();assert.equal(empty.nodes.get('admin-error-count').textContent,'0');assert.match(empty.nodes.get('admin-errors-status').textContent,/없습니다/);
  const failure=fixture({status:503});await settle();assert.equal(failure.nodes.get('admin-error-count').textContent,'—');assert.match(failure.nodes.get('admin-errors-status').textContent,/불러오지 못/);
  await failure.nodes.get('admin-errors-refresh').events.click();assert.equal(failure.calls.length,2);
  const partial=fixture({data:{...base,partial:true}});await settle();assert.equal(partial.nodes.get('admin-error-count').textContent,'≥ 12');assert.match(partial.nodes.get('admin-errors-status').textContent,/일부 결과/);
});
test('로그인 전 조회하지 않으며 로그아웃 뒤 도착한 응답은 본문을 복원하지 않는다',async()=>{
  assert.equal(fixture({hidden:true}).calls.length,0);
  let done;const f=fixture({data:base,pending:new Promise(r=>{done=r;})});f.nodes.get('admin-content').hidden=true;done();await settle();
  assert.equal(f.nodes.get('admin-error-count').textContent,'—');assert.equal(f.nodes.get('admin-errors-list').children.length,0);
});
test('서버 세션 거부는 본문을 숨기고 서버 로그인 화면을 다시 요청한다',async()=>{
  const f=fixture({status:401});await settle();assert.equal(f.nodes.get('admin-content').hidden,true);assert.ok(f.calls.includes('reload'));
});
