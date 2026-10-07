const test=require('node:test'),assert=require('node:assert/strict');
const {createNoticeService}=require('../services/noticeService');
const {sanitizeNoticeHtml}=require('../services/noticeContent');
function fixture(data={notices:[]}) {
 let revision='0',writes=0,failed=false;const storage={async read(){if(failed)throw Error('private-secret');return {data:structuredClone(data),revision};},async write(next,version){if(revision!==version)throw Object.assign(Error(),{code:412});data=structuredClone(next);revision=String(Number(revision)+1);writes++;return null;}};
 const service=createNoticeService({storage,now:()=>Date.parse('2026-10-07T14:59:00Z')});
 return{service,storage,writes:()=>writes,fail(){failed=true;},data:()=>data};
}
test('추가/수정/삭제와 고정 정렬, 기존 필드를 보존한다',async()=>{
 const f=fixture({extra:'keep',notices:[]});await f.service.mutate({action:'add',revision:'0',title:'첫 공지',content:'<b>본문</b>',isPinned:0});
 let r=await f.service.list();assert.equal(r.notices[0].id,'2026.10.07T23:59');
 await f.service.mutate({action:'add',revision:r.revision,title:'두번째',content:'',isPinned:1});r=await f.service.list();assert.equal(r.notices[0].id,'2026.10.08T00:00');
 await f.service.mutate({action:'update',id:r.notices[0].id,revision:r.revision,title:'수정',content:'<script>bad()</script><p>안전</p>',isPinned:0});r=await f.service.list();assert.equal(r.notices[0].content,'<p>안전</p>');
 await f.service.mutate({action:'delete',id:r.notices[0].id,revision:r.revision});assert.equal((await f.service.list()).notices.length,1);assert.equal(f.data().extra,'keep');
});
test('같은 버전의 동시 저장과 오래된 목록은 충돌 처리하며 최신 내용을 지우지 않는다',async()=>{
 const f=fixture();const input={action:'add',revision:'0',title:'공지',content:'',isPinned:0};
 const results=await Promise.allSettled([f.service.mutate(input),f.service.mutate(input)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 await assert.rejects(f.service.mutate(input),{status:409});assert.equal(f.writes(),1);
});
test('조회 장애·깨진 구조는 저장하지 않으며 빈 제목/잘못된 고정 순위를 거부한다',async()=>{
 const input={action:'add',revision:'0',title:'공지',content:'',isPinned:0};
 const f=fixture();f.fail();await assert.rejects(f.service.mutate(input));assert.equal(f.writes(),0);
 const broken=fixture({notices:'bad'});await assert.rejects(broken.service.mutate(input));assert.equal(broken.writes(),0);
 for(const change of [{title:'<b> </b>'},{isPinned:-1},{isPinned:1.5},{title:'a'.repeat(201)},{revision:undefined}])await assert.rejects(fixture().service.mutate({...input,...change}),{status:400});
});
test('미리보기·저장 HTML은 위험한 태그/속성을 제거하고 안전한 링크 서식만 남긴다',()=>{
 const f=fixture();const r=f.service.preview({title:'<b>제목</b>',content:'<script>secret</script><img src=x onerror=alert(1)><a href="javascript:alert(1)" onclick="x()">링크</a><b>본문</b>'});
 assert.equal(r.title,'제목');assert.doesNotMatch(r.content,/script|img|javascript|onclick|secret/);assert.match(r.content,/<b>본문<\/b>/);assert.equal(f.writes(),0);
 assert.match(sanitizeNoticeHtml('<a href="https://example.org" target="_blank">링크</a>'),/noopener noreferrer/);
});
test('기존 콘솔 도구는 클라이언트 버전 없이도 서버에서 조건부 저장한다',async()=>{
 const f=fixture();await f.service.mutate({action:'add',title:'공지',content:''},{requireRevision:false});assert.equal(f.writes(),1);
});
