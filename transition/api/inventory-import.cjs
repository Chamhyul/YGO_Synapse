'use strict';
const { createHash } = require('node:crypto');
const { migrationFetchPublicMyCardData, validateImportData } = require('../../functions/services/migrationService.js');
const { sheetsIsValidSpreadsheetId } = require('../../functions/integrations/googleSheets.js');
const { digestImport } = require('../../functions/services/inventoryImportRequests.js');

const fail = (code, status) => Object.assign(Error(code), { status });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const validSheetId = id => sheetsIsValidSpreadsheetId(id);

function importIdentity(uid, requestId, fingerprint) {
  if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)
      || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw fail('IMPORT_REQUEST_INVALID', 400);
  }
  return { operationId: hash(['inventory-import-v1', uid, requestId]).slice(0, 32), fingerprint };
}

async function prepareImport(source, body, readSheet) {
  let parsed;
  if (source === 'sheet') {
    if (!validSheetId(body.spreadsheetId)) throw fail('INVALID_IMPORT', 400);
    parsed = await readSheet(body.spreadsheetId);
    if (!body.fingerprint || body.fingerprint !== parsed.fingerprint) throw fail('SHEET_CHANGED', 409);
  } else {
    if (Array.isArray(body.data) && body.data.length > 50000) throw fail('INVALID_IMPORT', 400);
    parsed = validateImportData(body.data);
  }
  const groups = new Map();
  for (const item of parsed.data) {
    if ([item.name,item.no,item.rare,item.loc,item.illust].some(value => value.includes('\0'))) throw fail('INVALID_IMPORT', 400);
    // 기존 가져오기와 같은 일러스트 번호 정규화. 확인할 수 없는 문자열은 보존한다.
    const match = item.illust.match(/^(\d+)(?:st|nd|rd|th)?$/i);
    const illustration = item.illust === '기본' || item.illust === '0' ? '1'
      : match && Number(match[1]) > 0 ? String(Number(match[1])) : item.illust;
    const key = hash([item.no,item.rare,illustration]);
    const bucket = JSON.stringify([key,item.loc]);
    if (!groups.has(bucket)) groups.set(bucket, {
      key, name:item.name, number:item.no, rarity:item.rare, illustration, location:item.loc, qty:0,
    });
    groups.get(bucket).qty += item.qty;
  }
  return { ...parsed, rows:[...groups.values()] };
}

async function ensureInventoryLocations(client,uid,locationNames) {
  await client.query(`
    insert into app.inventory_heads(user_id,state) values($1,'active')
    on conflict(user_id) do update set state='active'`, [uid]);
  const added = await client.query(`
    with names as (
      select e.name,e.ordinality
      from unnest($2::text[]) with ordinality as e(name,ordinality)
      where not exists (select 1 from app.storage_locations s where s.user_id=$1 and s.name=e.name)
    ), numbered as (select name,row_number() over(order by ordinality) as n from names)
    insert into app.storage_locations(user_id,name,position,location_number)
    select $1,n.name,
      (select coalesce(max(position),0) from app.storage_locations where user_id=$1)+n.n,
      h.next_location_number+n.n-1
    from numbered n join app.inventory_heads h on h.user_id=$1
    returning id,name,position`, [uid,locationNames]);
  return added.rows;
}

async function storeImportRows(client, uid, parsed, fromRevision) {
  const { rows: [{ quantity }] } = await client.query(
    'select coalesce(sum(quantity),0)::text as quantity from app.inventory_items where user_id=$1', [uid]);
  if (BigInt(quantity) + BigInt(parsed.totalQty) > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('QUANTITY_LIMIT', 409);
  const added = await ensureInventoryLocations(client,uid,[...new Set(parsed.rows.map(row=>row.location))]);

  const input = JSON.stringify(parsed.rows);
  const { rows: saved } = await client.query(`
    with input as (
      select i.*,s.id as location_id
      from jsonb_to_recordset($2::jsonb) as i(key text,name text,number text,rarity text,illustration text,location text,qty bigint)
      join app.storage_locations s on s.user_id=$1 and s.name=i.location
    ), choices as (
      select i.key,min(v.id) as variant_id
      from (select distinct key,number,name,rarity,illustration from input) i
      join catalog.card_printings p on p.number=i.number
      join catalog.printing_variants v on v.printing_id=p.id and v.is_active
      join catalog.rarities r on r.id=v.rarity_id
      join catalog.artwork_sources a on a.id=v.artwork_source_id and a.official_ciid::text=i.illustration
      where exists (select 1 from catalog.card_localizations l where l.cid=p.cid and l.name=i.name)
        and (r.display_code=i.rarity or exists (
          select 1 from catalog.rarity_labels l where l.rarity_id=r.id and (l.label=i.rarity or l.display_code=i.rarity)
        ))
      group by i.key
      having count(distinct v.id)=1
    ), choice_map as (
      select jsonb_object_agg(key,variant_id) as variants from choices
    ), mapped as (
      -- 후보를 한 번 모아 입력 행마다 후보 전체를 다시 비교하지 않도록 한다.
      select i.*,(m.variants->>i.key)::bigint as variant_id,
        jsonb_build_object('name',i.name,'number',i.number,'rarity',i.rarity,'illustration',i.illustration) as original
      from input i cross join choice_map m
    ), written as (
      insert into app.inventory_items(user_id,location_id,variant_id,quantity,unresolved_details,import_key,import_details)
      select $1,location_id,variant_id,qty,
        case when variant_id is null then original end,key,case when variant_id is not null then original end
      from mapped
      on conflict(user_id,location_id,import_key) where import_key is not null
      do update set quantity=app.inventory_items.quantity+excluded.quantity
      returning id,location_id,import_key,variant_id,quantity,coalesce(import_details,unresolved_details)->>'name' as name
    )
    select w.id,w.location_id,w.variant_id,w.name,w.import_key as key,i.location,w.quantity::text,p.cid::text,p.id as printing_id
    from written w join input i on i.location_id=w.location_id and i.key=w.import_key
    left join catalog.printing_variants v on v.id=w.variant_id
    left join catalog.card_printings p on p.id=v.printing_id`, [uid,input]);
  if (saved.length !== parsed.rows.length) throw fail('IMPORT_RETRY_UNAVAILABLE', 503);
  const { rows:[{ revision }] } = await client.query(`
    update app.inventory_heads set revision=revision+1,next_location_number=next_location_number+$2
    where user_id=$1 returning revision::text`, [uid,added.length]);

  const byKey = new Map(saved.map(row => [JSON.stringify([row.key,row.location]),row]));
  const items = [], importedItems = [];
  for (const row of parsed.rows) {
    const current = byKey.get(JSON.stringify([row.key,row.location]));
    const item = { cardNo:row.number, name:row.name, cid:current.cid ?? null, rarity:row.rarity,
      loc:row.location, illustration:row.illustration, qty:row.qty };
    importedItems.push(item);
    items.push({
      id:current.id, locationId:current.location_id, quantity:current.quantity,
      printingId:current.printing_id, variantId:current.variant_id,
      ...(current.name===row.name?{}:{name:current.name}),
    });
  }
  const kinds = new Set(importedItems.map(item => item.cid ? 'cid:'+item.cid : 'name:'+item.name));
  return { success:true, importedCount:parsed.data.length, importedCardCount:kinds.size, importedQty:parsed.totalQty,
    importedItems, skippedZeroCount:parsed.skippedZeroCount, legacyQuantity:parsed.legacyQuantity,
    inventoryDelta:{fromRevision,revision,locations:added,items} };
}

function importResultView(result, { delta = false, applied = false } = {}) {
  if (!result?.inventoryDelta) return result;
  const { inventoryDelta, ...summary } = result;
  if (delta) return applied ? result : summary;
  const updatedItems = summary.importedItems.map((item,index)=>({
    ...item, qty:Number(inventoryDelta.items[index].quantity), isDeleted:false,
  }));
  return { ...summary, updatedItems };
}

module.exports = { MAX_IMPORT_BYTES, validSheetId, importIdentity, digestImport, prepareImport, storeImportRows, ensureInventoryLocations,
  importResultView, readPublicSheet:migrationFetchPublicMyCardData };
