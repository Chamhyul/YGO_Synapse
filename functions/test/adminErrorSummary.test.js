const test = require('node:test');
const assert = require('node:assert/strict');
const { createErrorSummaryService, normalizeGroup, CACHE_MS } = require('../services/adminErrorSummary');
const begin = '2026-10-06T00:00:00Z';
const group = (count, message = 'timeout private@example.invalid') => ({count: String(count), representative: {message}, affectedServices: [{service: 'photo-private-service'}], lastSeenTime: '2026-10-07T00:00:00Z', group: {groupId: 'private-group'}});
test('전체 페이지를 합산하고 상위5개만 정렬하며 원본 식별자를 제거한다', async () => {
  const tokens = [];
  const get = createErrorSummaryService({list: async ({period, pageToken}) => {
    assert.equal(period, 'PERIOD_1_DAY'); tokens.push(pageToken);
    return {timeRangeBegin: begin, errorGroupStats: pageToken ? [group(6), group(7)] : [1,2,3,4,5].map(n => group(n)), nextPageToken: pageToken ? undefined : 'next'};
  }});
  const data = await get(); assert.equal(data.occurrenceCount,28); assert.equal(data.groupCount,7);
  assert.deepEqual(data.topErrors.map(g => g.count),[7,6,5,4,3]); assert.equal(data.partial,false);
  assert.deepEqual(tokens,[undefined,'next']); assert.doesNotMatch(JSON.stringify(data), /private|example.invalid|groupId/);
});
test('빈 조회 결과는 실패와 구분되는 확정0건이다', async () => {
  const data = await createErrorSummaryService({list: async () => ({timeRangeBegin: begin})})();
  assert.equal(data.occurrenceCount,0); assert.equal(data.groupCount,0); assert.deepEqual(data.topErrors,[]);
});
test('60초 캐시와 진행 중 중복 요청을 공유한다', async () => {
  let time=0, calls=0, resolve;
  const get=createErrorSummaryService({now:()=>time,list:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  const one=get(), two=get(); resolve({timeRangeBegin:begin}); await Promise.all([one,two]);
  assert.equal(calls,1); time=CACHE_MS-1; await get(); assert.equal(calls,1);
  time=CACHE_MS; const three=get(); resolve({timeRangeBegin:begin}); await three; assert.equal(calls,2);
});
test('5페이지 초과는 일부 합계로 표시하고 반복된 페이지 토큰은 실패 처리한다', async () => {
  let page=0;
  const data=await createErrorSummaryService({list:async()=>({timeRangeBegin:begin,errorGroupStats:[group(1)],nextPageToken:String(++page)})})();
  assert.equal(page,5); assert.equal(data.partial,true); assert.equal(data.occurrenceCount,5);
  await assert.rejects(createErrorSummaryService({list:async()=>({timeRangeBegin:begin,nextPageToken:'same'})})());
});
test('조회 실패·불완전 응답·잘못된 건수는0으로 대체하지 않고 안전한 오류만 던진다', async () => {
  for (const list of [async()=>{throw Error('private-secret');},async()=>({}),async()=>({timeRangeBegin:begin,errorGroupStats:[group('99999999999999999999')]}),async()=>({timeRangeBegin:begin,errorGroupStats:[group('-1')]})]) {
    await assert.rejects(createErrorSummaryService({list})(), {message:'error-summary-unavailable'});
  }
});
test('실패 후10초 재시도 제한을 적용하고 만료된 캐시를 성공으로 반환하지 않는다', async () => {
  let time=0,calls=0,fail=false;
  const get=createErrorSummaryService({now:()=>time,list:async()=>{calls++;if(fail)throw Error();return {timeRangeBegin:begin};}});
  await get(); fail=true; time=CACHE_MS; await assert.rejects(get()); await assert.rejects(get()); assert.equal(calls,2);
  time+=10000;fail=false;await get();assert.equal(calls,3);
});
test('분류가 없거나 발생 시각이 잘못되어도 원문을 반환하지 않는다',()=>{
  assert.deepEqual(normalizeGroup(group(2,'Error: secret user data')), {description:'분류되지 않은 오류', feature:'이미지 처리', count:2,lastSeen:'2026-10-07T00:00:00.000Z'});
  assert.equal(normalizeGroup({count:'0'}).lastSeen,null);
});
