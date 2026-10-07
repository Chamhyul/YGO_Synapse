const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/admin-notices.js','utf8');const settle=()=>new Promise(r=>setImmediate(r));
function node(){return {value:'',textContent:'',hidden:false,disabled:false,children:[],events:{},attributes:{},addEventListener(k,fn){this.events[k]=fn;},append(...n){this.children.push(...n);},replaceChildren(...n){this.children=n;},setAttribute(k,v){this.attributes[k]=v;},querySelectorAll(){return[];},reportValidity(){return true;}};}
const notice={id:'2026.10.07T10:00',date:'2026.10.07',title:'기존 공지',content:'<p>본문</p>',isPinned:0};
function fixture({responses,hidden=false,confirm=true}={}) {
 const ids=['form','fields','new','reload','list','empty','search','title','body','pin','editor-title','date','delete','preview-heading','preview-body','environment','status','save','cancel','preview-button'];
 const nodes=new Map(ids.map(id=>['notice-'+id,node()]));const content=node();content.hidden=hidden;nodes.set('admin-content',content);
 const calls=[],events={};let reloads=0;
 const queue=responses||[{success:true,revision:'1',environment:'local',notices:[notice]}];
 vm.runInNewContext(source,{document:{getElementById:id=>nodes.get(id),createElement:node},window:{confirm:()=>confirm,location:{reload(){reloads++;}},addEventListener(k,fn){events[k]=fn;}},AbortController,setTimeout,clearTimeout,
 fetch:async(url,options)=>{calls.push({url,options});const next=queue.shift();const data=typeof next==='function'?await next():next;return{ok:!data.status,status:data.status||200,json:async()=>data};}});
 return{nodes,calls,events,reloads:()=>reloads,queue,get:id=>nodes.get('notice-'+id)};
}
test(' 목록 검색과 선택은 기존 내용을 편집하고 미저장 이동을 보호한다',async()=>{
 const f=fixture({confirm:false});await settle();assert.equal(f.get('fields').disabled,false);assert.match(f.get('environment').textContent,/로컬 테스트/);
 f.get('list').children[0].children[0].events.click();assert.equal(f.get('title').value,'기존 공지');
 f.get('title').value='수정중';f.get('new').events.click();assert.equal(f.get('title').value,'수정중');
 f.get('search').value='없는 제목';f.get('search').events.input();assert.match(f.get('empty').textContent,/검색 결과/);
 let blocked=false;f.events.beforeunload({preventDefault(){blocked=true;}});assert.equal(blocked,true);
});
test('저장 충돌은 작성 내용을 유지하고 버전 재조회 전 저장만 차단한다',async()=>{
 const f=fixture();await settle();f.get('title').value='새 제목';f.queue.push({status:409,message:'충돌'});
 f.get('form').events.submit({preventDefault(){}});await settle();assert.equal(f.get('title').value,'새 제목');assert.equal(f.get('save').disabled,true);assert.equal(f.get('fields').disabled,false);assert.match(f.get('status').textContent,/작성 내용은 유지/);
});
test('저장 성공 후 재조회 실패는 저장 완료와 구분하고 재전송을 막는다',async()=>{
 const f=fixture();await settle();f.get('title').value='새 제목';f.queue.push({success:true,notice},{status:503});f.get('form').events.submit({preventDefault(){}});await settle();
 assert.match(f.get('status').textContent,/저장은 완료/);assert.equal(f.get('save').disabled,true);
});
test('미리보기는 저장 API를 호출하지 않고 로그아웃 후 늦은 응답은 반영하지 않는다',async()=>{
 const f=fixture();await settle();f.queue.push({success:true,title:'미리보기',content:'<b>서식</b>'});await f.get('preview-button').events.click();assert.ok(f.calls.at(-1).url.endsWith('/preview'));assert.equal(f.get('preview-body').innerHTML,'<b>서식</b>');
 let done;const delayed=fixture({responses:[()=>new Promise(r=>{done=r;})]});delayed.nodes.get('admin-content').hidden=true;done({success:true,revision:'1',environment:'local',notices:[notice]});await settle();assert.equal(delayed.get('fields').disabled,true);assert.equal(delayed.get('list').children.length,0);
 assert.equal(fixture({hidden:true}).calls.length,0);
});
test('삭제는 확인을 받은 경우에만 선택된 공지 ID와 버전을 전송한다',async()=>{
 const cancel=fixture({confirm:false});await settle();cancel.get('list').children[0].children[0].events.click();await cancel.get('delete').events.click();assert.equal(cancel.calls.length,1);
 const f=fixture();await settle();f.get('list').children[0].children[0].events.click();f.queue.push({success:true,deletedId:notice.id},{success:true,revision:'2',environment:'local',notices:[]});await f.get('delete').events.click();
 const body=JSON.parse(f.calls[1].options.body);assert.equal(body.action,'delete');assert.equal(body.id,notice.id);assert.equal(body.revision,'1');assert.equal(f.get('delete').hidden,true);assert.match(f.get('status').textContent,/삭제했습니다/);
});
