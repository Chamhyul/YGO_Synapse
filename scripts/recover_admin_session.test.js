'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseArgs,main}=require('./recover_admin_session.cjs');
const args=['--writer-emulator','--backend','rtdb','--epoch','3','--operation','1'.repeat(32),'--parent-request','2'.repeat(32),'--recovery-request','3'.repeat(32)];
test('기본은 미리보기이며 명시 적용은 종료 확인과 미리보기 지문을 요구한다',()=>{
 assert.equal(parseArgs(args).apply,false);assert.equal(parseArgs(args).epoch,3);
 for(const extra of [['--apply'],['--apply','--writers-drained'],['--writer-production'],['--operation','4'.repeat(32)],['--expected-preview','private-raw']])assert.throws(()=>parseArgs([...args,...extra]));
 assert.equal(parseArgs([...args,'--apply','--writers-drained','--expected-preview','a'.repeat(64)]).apply,true);
});
test('도움말과 잘못된 인자는 SDK 생성 전에 끝나고 오류 원문을 출력하지 않는다',async()=>{
 let text='';const options={createRuntime:()=>assert.fail('SDK 금지'),stdout:s=>{text+=s;},stderr:s=>{text+=s;}};
 assert.equal(await main(['--help'],options),0);assert(text.includes('읽기 전용'));
 assert.equal(await main([...args,'--apply'],options),2);assert(!text.includes('SDK 금지'));
});
