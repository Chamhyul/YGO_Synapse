'use strict';
const {uncorrectedNumberCondition}=require('../crawler/number-corrections.cjs');

// SELECT만 생성한다. NULL 수치·번호 없음·미확정 공통 그림 그룹은 오류가 아니다.
function buildAuditQuery({expectedPacks = [], completedPacks = [], sampleLimit = 30} = {}) {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 200) throw Error('INVALID_SAMPLE_LIMIT');
  const seen = new Set();
  for (const p of expectedPacks) {
    const key = p.pid + ':' + p.locale;
    if (!/^\d{1,20}$/.test(p.pid) || !/^(ko|ja|ae|cn|en|de|fr|it|es|pt)$/.test(p.locale)
      || !Array.isArray(p.cids) || !p.cids.length || p.cids.some(c => !Number.isInteger(c) || c < 1)
      || new Set(p.cids).size !== p.cids.length || seen.has(key)) throw Error('INVALID_EXPECTED_PACK');
    seen.add(key);
  }
  const expected = JSON.stringify(expectedPacks).replaceAll("'", "''");
  const scope = {};
  for (const p of completedPacks) {
    if (!/^\d{1,20}$/.test(p.pid) || !/^(ko|ja|ae|cn|en|de|fr|it|es|pt)$/.test(p.locale)) throw Error('INVALID_COMPLETED_PACK');
    (scope[p.locale] ||= []).push(p.pid);
  }
  const scopeSql = Object.entries(scope).map(([locale,pids]) => `(p.locale='${locale}' and p.pid=any(array[${[...new Set(pids)].map(p=>"'"+p+"'").join(',')}]))`).join(' or ') || 'false';
  const checks = [
    ['pack_card_count', 'error', `select p.pid,p.locale,p.reported_card_count expected,count(pc.cid)::int actual
      from finished_packs p left join catalog.pack_cards pc using(pid,locale)
      where p.reported_card_count is not null group by p.pid,p.locale,p.reported_card_count
      having count(pc.cid)<>p.reported_card_count`],
    ['pack_positions', 'error', `select p.pid,p.locale,p.reported_card_count expected,
      count(pc.position)::int positioned,count(distinct pc.position)::int distinct_positions,min(pc.position) first,max(pc.position) last
      from finished_packs p left join catalog.pack_cards pc using(pid,locale)
      where p.reported_card_count>0 group by p.pid,p.locale,p.reported_card_count
      having count(pc.position)<>p.reported_card_count or count(distinct pc.position)<>p.reported_card_count
      or min(pc.position)<>1 or max(pc.position)<>p.reported_card_count`],
    ['pack_card_without_active_variant', 'review', `select pc.pid,pc.locale,pc.cid from catalog.pack_cards pc
      join finished_packs p using(pid,locale) where p.reported_card_count is not null
      and not exists(select from active a where a.pid=pc.pid and a.locale=pc.locale and a.cid=pc.cid)`],
    ['duplicate_printing', 'error', `select cid,pid,locale,number,number_status,count(*)::int copies
      from catalog.card_printings where number_status in('known','not_assigned')
      group by cid,pid,locale,number,number_status having count(*)>1`],
    ['duplicate_variant', 'error', `select printing_id,rarity_id,artwork_source_id,count(*)::int copies
      from catalog.printing_variants where is_active group by printing_id,rarity_id,artwork_source_id having count(*)>1`],
    ['variant_artwork_identity', 'error', `select a.id,a.cid,a.locale,a.artwork_source_id,s.cid source_cid,s.locale source_locale
      from active a left join catalog.artwork_sources s on s.id=a.artwork_source_id
      where s.id is null or a.cid<>s.cid or a.locale<>s.locale`],
    ['variant_localization', 'error', `select distinct a.cid,a.locale from active a
      left join catalog.card_localizations l using(cid,locale) where l.cid is null or btrim(l.name)=''`],
    ['variant_rarity', 'error', `select a.id,a.rarity_id from active a left join catalog.rarities r on r.id=a.rarity_id where r.id is null`],
    ['rarity_preferred_label', 'error', `select u.rarity_id,u.locale,count(l.label)::int preferred_labels from
      (select distinct rarity_id,locale from active) u left join catalog.rarity_labels l
      on l.rarity_id=u.rarity_id and l.locale=u.locale and l.is_preferred
      group by u.rarity_id,u.locale having count(l.label)<>1 or bool_or(btrim(l.label)='')`],
    ['rarity_display_code', 'review', `select distinct a.rarity_id,a.locale,l.label from active a
      join catalog.rarity_labels l on l.rarity_id=a.rarity_id and l.locale=a.locale and l.is_preferred
      join catalog.rarities r on r.id=a.rarity_id where nullif(btrim(coalesce(l.display_code,r.display_code)),'') is null`],
    ['number_encoding', 'error', `select id,cid,pid,locale,number,number_status from catalog.card_printings where
      (number_status='known' and (number is null or btrim(number)='' or number<>upper(btrim(number))))
      or (number_status in('not_assigned','unverified') and number is not null)
      or number_status not in('known','not_assigned','unverified')`],
    ['number_nfkc', 'review', `select id,cid,pid,locale,number,normalize(number,NFKC) normalized from catalog.card_printings where number_status='known' and number<>normalize(number,NFKC)`],
    ['approved_number_corrections', 'error', `select p.id,p.cid,p.pid,p.locale,p.number from catalog.card_printings p where ${uncorrectedNumberCondition('p')}`],
    ['number_unverified', 'review', `select distinct cid,pid,locale from active where number_status='unverified'`],
    ['number_multiple_cards', 'review', `select pid,locale,number,array_agg(distinct cid order by cid) cids from active
      where number_status='known' group by pid,locale,number having count(distinct cid)>1`],
    ['image_mapping_unresolved', 'pending', `select s.cid,s.locale,s.official_ciid from used_sources s where s.image_ciid is null`],
    ['image_mapping_invalid', 'error', `select id,cid,locale,official_ciid,image_ciid,image_variant from catalog.artwork_sources where
      (image_ciid is null)<>(image_variant is null) or image_ciid not between 1 and 100
      or image_variant not in('base','jp') or (image_variant='jp' and image_ciid<>1)`],
    ['artwork_group_mismatch', 'error', `select s.id,s.cid,s.artwork_id from catalog.artwork_sources s
      left join catalog.artworks a on a.id=s.artwork_id where s.artwork_id is not null and (a.id is null or a.cid<>s.cid)`],
    ['expected_pack_missing', 'error', `select e.pid,e.locale,e.cid from expected_cards e
      left join catalog.pack_cards pc using(pid,locale,cid)
      left join (select distinct pid,locale,cid from active) a using(pid,locale,cid)
      where pc.cid is null or a.cid is null`],
    ['expected_pack_extra', 'review', `select pc.pid,pc.locale,pc.cid from catalog.pack_cards pc
      join expected_packs e using(pid,locale) where not exists(select from expected_cards x where x.pid=pc.pid and x.locale=pc.locale and x.cid=pc.cid)`],
    ['expected_pack_order', 'error', `select e.pid,e.locale,e.cid,e.position expected,pc.position actual from expected_cards e
      join catalog.pack_cards pc using(pid,locale,cid) where pc.position is distinct from e.position`]
  ];
  return `with active as not materialized(select v.id,v.printing_id,v.rarity_id,v.artwork_source_id,p.cid,p.pid,p.locale,p.number,p.number_status
    from catalog.printing_variants v join catalog.card_printings p on p.id=v.printing_id where v.is_active),
    used_sources as materialized(select distinct s.* from catalog.artwork_sources s join active a on a.artwork_source_id=s.id),
    finished_packs as materialized(select p.* from catalog.packs p where ${scopeSql}),
    expected_packs as(select * from jsonb_to_recordset('${expected}'::jsonb) as x(pid text,locale text,cids jsonb)),
    expected_cards as(select e.pid,e.locale,c.value::integer cid,c.ordinality::integer position
      from expected_packs e cross join lateral jsonb_array_elements_text(e.cids) with ordinality c(value,ordinality)),
    ${checks.map(([id,,sql]) => `${id} as materialized(${sql})`).join(',\n')}
    select jsonb_build_object('checkedAt',statement_timestamp(),'scope',jsonb_build_object(
      'cards',(select count(*) from catalog.cards),'localizedCards',(select count(*) from catalog.card_localizations),
      'activeVariants',(select count(*) from active),'completedPackScope',${completedPacks.length},'packsWithVerifiedCount',(select count(*) from finished_packs where reported_card_count is not null),
      'unresolvedImageSources',(select count(*) from used_sources where image_ciid is null),
      'unresolvedImageCidCiidPairs',(select count(distinct (cid,official_ciid)) from used_sources where image_ciid is null),
      'packsAwaitingPackCheck',(select count(*) from catalog.packs where reported_card_count is null),
      'expectedPackSamples',(select count(*) from expected_packs)),
      'imageMappingByLocale',(select coalesce(jsonb_agg(x),'[]') from (select locale,count(*) sources,
        count(*) filter(where image_ciid is null) unresolved from used_sources group by locale order by locale) x),
      'checks',jsonb_build_array(${checks.map(([id,level]) => `jsonb_build_object('id','${id}','level','${level}',
        'count',(select count(*) from ${id}),'samples',(select coalesce(jsonb_agg(x),'[]') from
        (select * from ${id} order by to_jsonb(${id})::text limit ${sampleLimit}) x))`).join(',\n')})) report`;
}

async function runAudit(pool, options) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    const {rows} = await client.query(buildAuditQuery(options));
    await client.query('ROLLBACK');
    return rows[0].report;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}
module.exports = {buildAuditQuery, runAudit};
