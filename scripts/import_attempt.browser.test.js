'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{chromium}=require('playwright');
test('실제 Chromium의 응답 유실·새로고침·재선택은 동일 영수증만 표시하고 다음 새 가져오기는 추가한다',async()=>{
 const browser=await chromium.launch();let saved=null,posts=0,first=true;const ids=[];
 try{const page=await browser.newPage();await page.route('**/*',async route=>{const u=new URL(route.request().url());
 if(u.pathname==='/import-attempt.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync('public/import-attempt.js','utf8')});
 if(u.pathname==='/api'){
  if(route.request().method()==='GET'){ids.push(u.searchParams.get('importRequestId'));return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,importRequest:{status:saved?'completed':'missing'},...(saved?{result:saved}:{})})});}
  posts++;saved={success:true,importedQty:4};if(first){first=false;return route.abort();}return route.fulfill({contentType:'application/json',body:JSON.stringify(saved)});
 }
 return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><button id="run">가져오기</button><div id="result"></div><script src="/import-attempt.js"></script><script>
 document.getElementById('run').onclick=async()=>{const button=document.getElementById('run');button.disabled=true;try{const result=await YgoImportAttempt.execute({uid:'synthetic',source:'file',payload:{data:[{no:'SYN-001',qty:4}]},isCurrent:()=>true,send:async(query,body)=>{const response=await fetch('/api?'+new URLSearchParams(query),{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});return response.json();}});document.getElementById('result').textContent='완료 '+result.importedQty;}catch(e){document.getElementById('result').textContent='확인 필요';}finally{button.disabled=false;}};</script>`});
 });await page.goto('https://synthetic.web.app/');await page.locator('#run').click();await page.waitForFunction(()=>document.getElementById('result').textContent.length>0,{},{timeout:5000});assert.equal(await page.locator('#result').textContent(),'확인 필요');assert.equal(posts,1);
 await page.reload();await page.locator('#run').click();await page.waitForFunction(()=>document.getElementById('result').textContent==='완료 4');assert.equal(posts,1);assert.equal(ids[0],ids[1]);
 saved=null;await page.locator('#run').click();await page.waitForFunction(()=>!document.getElementById('run').disabled);assert.equal(posts,2);assert.notEqual(ids[1],ids[2]);
 }finally{await browser.close();}
});
