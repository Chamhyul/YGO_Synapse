'use strict';
const locales = ['ko','ja','ae','cn','en','de','fr','it','es','pt'];

// 읽기 전용 주입 함수. 원격 write/save와 공식 사이트 요청을 사용하지 않는다.
async function loadAuditScope(read, {packLimit = 20} = {}) {
  if (!Number.isInteger(packLimit) || packLimit < 0 || packLimit > 10000) throw Error('INVALID_PACK_LIMIT');
  const state = await read('state');
  if (state?.version !== 1 || !Number.isInteger(state.localeIndex) || state.localeIndex < 0 || state.localeIndex > locales.length) throw Error('INVALID_CRAWL_STATE');
  const completedPacks = [], expectedPacks = [], reviews = [], skipped = [];
  for (let i = 0; i < locales.length; i++) {
    const locale = locales[i], count = state.counts?.[locale]?.packs || 0;
    if (!count) continue;
    const catalog = await read('catalogs/' + locale);
    if (!Array.isArray(catalog) || count > catalog.length || (i === state.localeIndex && count !== state.packIndex)
      || (i > state.localeIndex)) throw Error('CHECKPOINT_CURSOR_MISMATCH');
    const completed = catalog.slice(0,count);
    completedPacks.push(...completed.map(p => ({pid:p.pid,locale})));
    // 앞부분만 검사하지 않도록 완료 구간에 균등한 표본을 선택한다. 0은 전체 대조.
    const size = packLimit ? Math.min(packLimit,count) : count;
    const indices = new Set(Array.from({length:size},(_,j)=>size===1?0:Math.round(j*(count-1)/(size-1))));
    for (const j of indices) {
      const p = completed[j], key = locale+'/'+p.pid;
      let result = await read('pack-results/'+key);
      let snapshotKey = 'packs/'+key;
      if (result?.status !== 'complete' && state.recovery?.locale === locale) {
        const recovered = await read('pack-rechecks/'+state.recovery.id+'/'+key);
        if (recovered) { result = recovered; snapshotKey = 'rechecked-packs/'+state.recovery.id+'/'+key; }
      }
      if (!result) { skipped.push({...p,reason:'RESULT_NOT_FOUND'}); continue; }
      if (result.status !== 'complete') { reviews.push({...p,status:result.status,code:result.code}); continue; }
      const snapshot = await read(snapshotKey);
      if (!snapshot || snapshot.pid !== p.pid || snapshot.locale !== locale || !Array.isArray(snapshot.cids)
        || snapshot.cids.length !== result.expected) throw Error('CHECKPOINT_PACK_MISMATCH');
      expectedPacks.push({pid:p.pid,locale,cids:snapshot.cids});
    }
  }
  return {completedPacks,expectedPacks,coverage:{runId:state.id,stateUpdatedAt:state.updatedAt,status:state.status,
    completedPacks:completedPacks.length,comparedPacks:expectedPacks.length,packLimitPerLocale:packLimit,reviews,skipped}};
}
module.exports = {loadAuditScope};
