'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('playwright');
const root=require('node:path').resolve(__dirname,'..');
const html=fs.readFileSync(root+'/public/index.html','utf8');
const source=fs.readFileSync(root+'/public/script.js','utf8');
const begin=source.indexOf('let pendingMigrationData = null;');
const controller=source.slice(begin,source.indexOf('function checkAuthBeforeAction()',begin));
const asset=process.env.SHEETJS_TEST_ASSET;
const headers=['카드 이름','카드 번호','레어도','수량','보관 위치','일러스트'];
const rows=[headers,['가상 카드','TEST-KR001','SE',4,'검증용 장소','2']];
async function fixture(page,{failed=false}={}){
 let release;const ready=new Promise(r=>release=r),requests=[];
 const body=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>',`<script src="/data-transfer.js"></script><script src="/spreadsheet-loader.js"></script><script src="/controller.js"></script></body>`);
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.hostname==='cdn.sheetjs.com'){requests.push(u.href);await ready;if(failed)return route.abort();return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(asset)});}
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body});
  if(['/data-transfer.js','/spreadsheet-loader.js'].includes(u.pathname))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(root+'/public'+u.pathname)});
  if(u.pathname==='/controller.js')return route.fulfill({contentType:'text/javascript',body:`const UserStore={user:{uid:'synthetic'}};let migrationValidationTimeout;function getAppModal(){return{open(){}}}${controller}`});
  return route.fulfill({contentType:'text/plain',body:''});
 });
 await page.goto('https://synthetic.web.app/');await page.evaluate(()=>openMigrationModal('file'));
 return{release,requests};
}
test('실제 SheetJS의 xls/xlsx MyCard를 필요할 때 한 번 내려받아 기존 수량·형식으로 미리보기한다',{skip:!asset},async()=>{
 const XLSX=require(asset),browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage(),f=await fixture(page);assert.equal(f.requests.length,0);
  for(const type of ['xls','xlsx']){
   const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'MyCard');
   const bytes=Buffer.from(XLSX.write(book,{bookType:type==='xls'?'biff8':'xlsx',type:'buffer'}));
   await page.locator('#migration-file-input').setInputFiles({name:'synthetic.'+type,mimeType:'application/octet-stream',buffer:bytes});
   await page.waitForFunction(()=>document.getElementById('mig-file-name').textContent.startsWith('synthetic.'));
   if(type==='xls'){await page.waitForFunction(()=>document.querySelector('script[src*="cdn.sheetjs.com"]'));assert.equal(await page.locator('#migration-exec-btn').isEnabled(),false);f.release();}
   await page.waitForFunction(()=>!document.getElementById('migration-exec-btn').disabled);
   assert.match(await page.locator('#migration-status-msg').textContent(),/1개 항목 · 4장/);
  }
  assert.equal(f.requests.length,1);
 }finally{await browser.close();}
});
test('Excel CDN 실패 뒤 CSV는 별도 라이브러리 요청 없이 기존 검증을 계속한다',{skip:!asset},async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage(),f=await fixture(page,{failed:true});
  await page.locator('#migration-file-input').setInputFiles({name:'synthetic.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic')});
  await page.waitForFunction(()=>document.querySelector('script[src*="cdn.sheetjs.com"]'));f.release();
  await page.waitForFunction(()=>document.getElementById('migration-status-msg').textContent.includes('다시 선택'));
  assert.equal(await page.locator('#migration-exec-btn').isEnabled(),false);
  const csv=require('../public/data-transfer').toCsv([rows[1]]);
  await page.locator('#migration-file-input').setInputFiles({name:'synthetic.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
  await page.waitForFunction(()=>!document.getElementById('migration-exec-btn').disabled);
  assert.equal(f.requests.length,1);
 }finally{await browser.close();}
});
