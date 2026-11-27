'use strict';
const Hangul = require('../../public/vendor/ui/1c892e8a26f8b37e51cd118e4cc61d864de6e4fc1f1df5d3386bdfe5277a0b7f.js');

const confirmedPack = `count(distinct m.position)=count(*)
    and (p.reported_card_count is null or p.reported_card_count=count(*))
    and bool_and(coalesce(l.name,'')<>'' and exists(
      select from catalog.card_printings cp where cp.pid=m.pid and cp.locale=m.locale and cp.cid=m.cid
        and exists(select from catalog.printing_variants v where v.printing_id=cp.id and v.is_active)
    ))`;

function createPackSuggestions(pool) {
  return async function findPackSuggestions(query) {
    if (typeof query !== 'string' || query.length>160) throw Object.assign(Error('INVALID_QUERY'), {status:400});
    if (query.includes('\0') || !query.isWellFormed()) return [];
    const term = query.normalize('NFC').replace(/\s+/gu,'').toLowerCase();
    const { rows } = await pool.query(`with matches as materialized (
      select p.pid,p.locale,p.autocomplete_display_name as name,
        case when p.autocomplete_normalized_name=$1 then 0
             when strpos(p.autocomplete_jamo collate "C",$2)=1 then 1 else 2 end as rank
      from catalog.packs p where strpos(p.autocomplete_jamo collate "C",$2)>0
        and p.autocomplete_normalized_name<>''
    ), ranked as (
      select name,rank,jsonb_agg(jsonb_build_object('pid',pid,'locale',locale)) as versions
      from matches where pid ~ '^[a-zA-Z0-9-]{1,40}$'
      group by 1,2
    ), ordered as (
      select array_agg(name order by rank,name) as names,array_agg(versions order by rank,name) as versions from ranked
    )
      select available.name from ordered
      cross join lateral (
        select candidate.name,candidate.position
        from unnest(ordered.names,ordered.versions) with ordinality as candidate(name,versions,position)
        where exists (
          select 1 from jsonb_to_recordset(candidate.versions) as version(pid text,locale text)
          where exists (
            select 1 from catalog.packs p join catalog.pack_cards m using(pid,locale)
            left join catalog.card_localizations l on l.cid=m.cid and l.locale=m.locale
            where p.pid=version.pid and p.locale=version.locale
            group by p.pid,p.locale,p.reported_card_count having ${confirmedPack}
          )
        )
        order by candidate.position limit 5
      ) available order by available.position`,[term,Hangul.disassembleToString(term)]);
    return rows.map(({name})=>name);
  };
}

module.exports = { confirmedPack, createPackSuggestions };
