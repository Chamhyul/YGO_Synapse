'use strict';
// Experimental, offline evaluation only. Not used by the service yet.
const sharp=require('sharp'),ort=require('onnxruntime-web'),path=require('path');
const cv=require('../public/vendor/opencv');
const {preprocess,parse}=require('./evaluate_draw2_detector');
const {cropPixels}=require('../public/photo-card-geometry');
async function main(){
 const [imagePath,...referenceKeys]=process.argv.slice(2);
 if(!imagePath||!referenceKeys.length||referenceKeys.some(k=>!/^\d+_\d+$/.test(k)))throw new Error('Usage: node scripts/evaluate_photo_features.js IMAGE CID_CIID...');
 await new Promise((resolve,reject)=>{let count=0;const timer=setInterval(()=>{if(cv.Mat){clearInterval(timer);resolve();}else if(++count>100){clearInterval(timer);reject(new Error('OpenCV timeout'));}},50);});
 const orb=new cv.ORB(1200,1.2,8,15,0,2,0,31,10);
 const matcher=new cv.BFMatcher(cv.NORM_HAMMING,false);
 function describe(pixels){const rgba=cv.matFromArray(pixels.height,pixels.width,cv.CV_8UC4,pixels.data),gray=new cv.Mat(),mask=new cv.Mat(),points=new cv.KeyPointVector(),descriptors=new cv.Mat();try{cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);orb.detectAndCompute(gray,mask,points,descriptors);return {points,descriptors};}finally{rgba.delete();gray.delete();mask.delete();}}
 function compare(a,b){if(a.descriptors.rows<4||b.descriptors.rows<4)return 0;const pairs=new cv.DMatchVectorVector(),src=[],dst=[];try{matcher.knnMatch(a.descriptors,b.descriptors,pairs,2);for(let i=0;i<pairs.size();i++){const pair=pairs.get(i);try{if(pair.size()<2)continue;const m=pair.get(0),second=pair.get(1);if(m.distance<second.distance*.75){const p=a.points.get(m.queryIdx).pt,q=b.points.get(m.trainIdx).pt;src.push(p.x,p.y);dst.push(q.x,q.y);}}finally{pair.delete();}}}finally{pairs.delete();}if(src.length<8)return 0;const s=cv.matFromArray(src.length/2,1,cv.CV_32FC2,src),d=cv.matFromArray(dst.length/2,1,cv.CV_32FC2,dst),mask=new cv.Mat();let h;try{h=cv.findHomography(s,d,cv.RANSAC,4,mask);return h.empty()?0:cv.countNonZero(mask);}finally{s.delete();d.delete();mask.delete();h?.delete();}}
 const references=[];
 for(const key of referenceKeys){const {data,info}=await sharp(path.resolve(__dirname,'../resources/illustrations',key+'.webp')).resize(320,320).ensureAlpha().raw().toBuffer({resolveWithObject:true});references.push({key,...describe({data,width:info.width,height:info.height})});}
 ort.env.wasm.numThreads=1;const session=await ort.InferenceSession.create(path.resolve(__dirname,'../public/vendor/ygo-card-detector.onnx'));
 const input=await preprocess(imagePath),out=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',input.tensor,[1,3,640,640])});
 const detections=parse(out[session.outputNames[0]],input.width,input.height,input.scale,input.padX,input.padY);
 const {data,info}=await sharp(imagePath).rotate().ensureAlpha().raw().toBuffer({resolveWithObject:true});
 for(const [region,detection] of detections.entries()){const polygon=detection.points.map(p=>({x:p.x/input.width,y:p.y/input.height}));const crop=cropPixels({data,width:info.width,height:info.height},polygon,{x:.08,y:.10,width:.84,height:.65},420,420);const query=describe(crop);console.log(JSON.stringify({region:region+1,matches:references.map(ref=>({key:ref.key,inliers:compare(query,ref)})).sort((a,b)=>b.inliers-a.inliers)}));query.points.delete();query.descriptors.delete();}
 references.forEach(ref=>{ref.points.delete();ref.descriptors.delete();});orb.delete();matcher.delete();await session.release();
}
main().catch(error=>{console.error('특징 비교 평가 실패: '+error.message);process.exitCode=1;});
