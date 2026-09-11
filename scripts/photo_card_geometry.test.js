const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {cardQuad,projectiveMap,cropPixels}=require('../public/photo-card-geometry');
test('원근 투영은 네 모서리를 정확히 대응한다',()=>{
 const p=[{x:10,y:20},{x:90,y:10},{x:100,y:160},{x:0,y:150}],f=projectiveMap(p);
 [[0,0],[1,0],[1,1],[0,1]].forEach(([u,v],i)=>{const q=f(u,v);assert.ok(Math.abs(q.x-p[i].x)<1e-6);assert.ok(Math.abs(q.y-p[i].y)<1e-6);});
});
test('사진 가로세로 비율을 반영해 카드의 짧은 변을 가로로 정렬한다',()=>{
 const p=cardQuad([{x:.1,y:.1},{x:.4,y:.1},{x:.4,y:.8},{x:.1,y:.8}],400,200);
 assert.equal(Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y),120);
});
test('퇴화한 사각형은 잘못된 샘플링 대신 오류를 반환한다',()=>{
 assert.throws(()=>projectiveMap(Array.from({length:4},()=>({x:0,y:0}))));
});
test('일러스트 샘플링 결과 크기와 픽셀을 보존한다',()=>{
 const data=new Uint8ClampedArray(8*12*4);for(let i=0;i<data.length;i+=4){data[i]=123;data[i+3]=255;}
 const c=cropPixels({data,width:8,height:12},[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],{x:.1,y:.2,width:.8,height:.5},16,16);
 assert.equal(c.data.length,1024);assert.equal(c.data[0],123);assert.equal(c.data[3],255);
});
test('WASM 모듈 경로는 워커 기준 절대 URL이어야 한다',()=>{
 const source=fs.readFileSync(require.resolve('../public/photo-card-model-worker.js'),'utf8');
 assert.match(source,/wasmPaths = new URL\('vendor\/', self.location.href\).href/);
});
test('휴대폰 EXIF 회전 후 치수로 모델 입력 비율을 계산한다',async()=>{
 const sharp=require('sharp');
 const {preprocess}=require('./evaluate_draw2_detector');
 const bytes=await sharp({create:{width:40,height:20,channels:3,background:'#ffffff'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 const input=await preprocess(bytes);
 assert.equal(input.width,20);assert.equal(input.height,40);
 assert.equal(input.padX,160);assert.equal(input.padY,0);
});
