'use strict';
// Read-only evaluation against the same private Storage index as production.
const sharp = require('sharp');
const ort = require('onnxruntime-web');
const { preprocess, parse } = require('./evaluate_draw2_detector');
const { initializeStorage } = require('./upload_card_illustrations');
const { cropPixels } = require('../public/photo-card-geometry');
const { CARD_ART_CROPS } = require('../public/photo-card-search');
async function main() {
    const paths = process.argv.slice(2);
    if (!paths.length) throw new Error('Usage: node scripts/evaluate_photo_search.js IMAGE...');
    const { bucket } = initializeStorage('ygo-synapse.firebasestorage.app');
    const { phashImage, findNearest } = require('../functions/services/cardImageSearchService');
    const [bytes] = await bucket.file('system/illustration-search/phash.json').download();
    const index = JSON.parse(bytes);
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(require('path').resolve(__dirname, '../public/vendor/ygo-card-detector.onnx'));
    for (const path of paths) {
        const input = await preprocess(path);
        const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input.tensor, [1, 3, 640, 640]) });
        const detections = parse(outputs[session.outputNames[0]], input.width, input.height, input.scale, input.padX, input.padY);
        const { data, info } = await sharp(path).rotate().resize({width:1800,height:1800,fit:'inside',withoutEnlargement:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
        const regions = [];
        for (const detection of detections) {
            const polygon = detection.points.map(p => ({x:p.x/input.width,y:p.y/input.height}));
            const matches = new Map();
            for (const pattern of CARD_ART_CROPS) {
                const crop = cropPixels({data,width:info.width,height:info.height},polygon,pattern);
                const jpeg = await sharp(crop.data,{raw:{width:crop.width,height:crop.height,channels:4}}).jpeg({quality:90}).toBuffer();
                for (const match of findNearest(index,await phashImage(jpeg),5,22)) {
                    if (!matches.has(match.cid) || matches.get(match.cid).distance > match.distance) matches.set(match.cid,match);
                }
            }
            regions.push({confidence:detection.confidence,polygon,matches:[...matches.values()].sort((a,b)=>a.distance-b.distance).slice(0,5)});
        }
        console.log(JSON.stringify({image:path,regions},null,2));
    }
}
main().catch(error => { console.error('사진 평가 실패: '+error.message);process.exitCode=1; });
