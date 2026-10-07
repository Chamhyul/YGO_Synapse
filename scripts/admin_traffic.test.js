const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const source=fs.readFileSync('public/admin-home.js','utf8');const settle=()=>new Promise(r=>setImmediate(r));
const node=()=>({hidden:false,disabled:false,textContent:'',innerHTML:'',attrs:{},events:{},classList:{toggle(){}},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this.events[k]=fn;}});
const data=()=>({success:true,current:{activeUsers:4,sessions:5,screenPageViews:6},previous:{activeUsers:1,sessions:2,screenPageViews:3},queriedAt:'2026-10-07T04:00:00Z',hostname:'ygo-synapse.web.app',daily:Array.from({length:30},(_,i)=>({date:new Date(Date.UTC(2026,8,8+i)).toISOString().slice(0,10),value:i}))});
function fixture({payload=data(),code=200,pending,hidden=false}={}) {
 const ids=['admin-content','admin-traffic-chart','admin-traffic-rows','admin-traffic-refresh','admin-traffic-status','admin-traffic-source','trend-range',...['activeUsers','sessions','screenPageViews'].flatMap(m=>['admin-traffic-'+m,'admin-previous-'+m])];
 const nodes=new Map(ids.map(id=>[id,node()]));nodes.get('admin-content').hidden=hidden;
 const buttons=[7,30].map(n=>Object.assign(node(),{dataset:{trendDays:String(n)}}));let calls=0,reloads=0;
 const f={nodes,buttons,fail(){code=503;},calls:()=>calls,reloads:()=>reloads};
 vm.runInNewContext(source,{document:{getElementById:id=>nodes.get(id),querySelectorAll:()=>buttons},Intl,AbortController,setTimeout,clearTimeout,
 window:{location:{reload(){reloads++;}}},fetch:async()=>{calls++;if(pending)await pending;return{ok:code===200,status:code,json:async()=>payload};}});return f;
}
test('실제 요약값과7일/30일 그래프·표를 함께 표시하며 기간 전환에 추가 조회가 없다',async()=>{
 const f=fixture();assert.equal(f.nodes.get('admin-traffic-activeUsers').textContent,'—');await settle();
 assert.equal(f.nodes.get('admin-traffic-activeUsers').textContent,'4');assert.equal(f.nodes.get('admin-previous-screenPageViews').textContent,'어제 3회');
 assert.equal((f.nodes.get('admin-traffic-rows').innerHTML.match(/<tr>/g)||[]).length,7);
 f.buttons[1].events.click();assert.equal((f.nodes.get('admin-traffic-rows').innerHTML.match(/<tr>/g)||[]).length,30);assert.equal(f.calls(),1);assert.equal(f.buttons[1].attrs['aria-pressed'],'true');
 assert.doesNotMatch(f.nodes.get('admin-traffic-chart').innerHTML,/예시|NaN|Infinity/);
});
test('수집0건은0과 평평한 그래프, 조회 실패는빈 값/표로 구분한다',async()=>{
 const payload=data();payload.daily.forEach(d=>{d.value=0;});payload.current={activeUsers:0,sessions:0,screenPageViews:0};
 const f=fixture({payload});await settle();assert.equal(f.nodes.get('admin-traffic-activeUsers').textContent,'0');assert.doesNotMatch(f.nodes.get('admin-traffic-chart').innerHTML,/NaN|Infinity/);
 f.fail();await f.nodes.get('admin-traffic-refresh').events.click();assert.equal(f.nodes.get('admin-traffic-activeUsers').textContent,'—');assert.equal(f.nodes.get('admin-traffic-chart').innerHTML,'');assert.equal(f.nodes.get('admin-traffic-rows').innerHTML,'');assert.equal(f.buttons[0].disabled,true);assert.equal(f.nodes.get('admin-traffic-refresh').disabled,false);
});
test('로그아웃 후 늦은 응답은 표시하지 않고401은본문을 숨기고 재요청한다',async()=>{
 let done;const f=fixture({pending:new Promise(r=>{done=r;})});f.nodes.get('admin-content').hidden=true;done();await settle();assert.equal(f.nodes.get('admin-traffic-activeUsers').textContent,'—');
 const denied=fixture({code:401});await settle();assert.equal(denied.nodes.get('admin-content').hidden,true);assert.equal(denied.reloads(),1);assert.equal(fixture({hidden:true}).calls(),0);
});
test('잘못된 데이터는 SVG/표에 삽입하지 않으며 GA4 데이터 제한 안내를 표시한다',async()=>{
 const invalid=data();invalid.daily[0].date='<img src=x>';const f=fixture({payload:invalid});await settle();assert.equal(f.nodes.get('admin-traffic-chart').innerHTML,'');assert.match(f.nodes.get('admin-traffic-status').textContent,/못했습니다/);
 const limited=fixture({payload:{...data(),limited:true}});await settle();assert.match(limited.nodes.get('admin-traffic-status').textContent,/데이터 제한/);
});
