'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRequest, cardIndex, createHandler, createLimiter } = require('../services/illustrationDelivery');

test('only exact card routes accepted, no traversal or whole index', () => {
  assert.deepEqual(parseRequest('/api/illustrations/4007_1.webp'), { cid: '4007', ciid: '1' });
  for (const path of ['/api/illustrations/index.json', '/api/illustrations/../secret', '/api/illustrations/0.json', '/api/illustrations/12_0.webp']) assert.equal(parseRequest(path), null);
});
test('metadata excludes other cards and sensitive fields', () => {
  const result = cardIndex({ files: { '12_1': { sourceImageId: '33', storagePath: 'secret', downloadTokens: 'secret' }, '13_1': {} } }, '12');
  assert.deepEqual(Object.keys(result.files), ['12_1']);
  assert(!JSON.stringify(result).includes('secret'));
});
test('burst guard rejects excess requests', () => {
  const allow = createLimiter(1); assert(allow('a')); assert(!allow('a')); assert(allow('b'));
});
function response() { return { headers: {}, statusCode: 200, setHeader(k,v) { this.headers[k]=v; }, status(v) { this.statusCode=v; return this; }, end() {}, send(v) { this.body=v; }, json(v) { this.body=v; } }; }
test('handler reads only private image path and prevents shared caching', async () => {
  let path;
  const handler = createHandler({ download: async p => { path=p; return Buffer.from('image'); }, allow:()=>true });
  const res=response(); await handler({ method:'GET', path:'/api/illustrations/12_1.webp', ip:'a' },res);
  assert.equal(path,'private/illustrations/12_1.webp'); assert.equal(res.statusCode,200);
  assert.equal(res.headers['Cache-Control'],'private, no-store');
});
test('invalid, throttled, and missing requests do not expose error details', async () => {
  for (const [method,path,allow,code] of [['POST','/api/illustrations/12.json',true,405],['GET','/api/illustrations/index.json',true,404],['GET','/api/illustrations/12.json',false,429],['GET','/api/illustrations/12.json',true,404]]) {
    const handler=createHandler({ download:async()=>{throw Object.assign(new Error('secret'),{code:404});},allow:()=>allow });
    const res=response();await handler({method,path,ip:'a'},res);assert.equal(res.statusCode,code);assert.equal(res.body,undefined);
  }
});
