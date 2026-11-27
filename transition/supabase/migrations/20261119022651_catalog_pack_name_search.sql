CREATE FUNCTION catalog.pack_search_normalize(value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
RETURN lower(translate(
  normalize(regexp_replace(btrim(value), '[[:space:]]+', ' ', 'g'), NFC),
  U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF',
  '') COLLATE "und-x-icu");

CREATE FUNCTION catalog.pack_search_jamo(value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $$
  WITH jamo AS (
    SELECT regexp_split_to_array('ㄱ ㄲ ㄴ ㄷ ㄸ ㄹ ㅁ ㅂ ㅃ ㅅ ㅆ ㅇ ㅈ ㅉ ㅊ ㅋ ㅌ ㅍ ㅎ',' ') AS initials,
           regexp_split_to_array('ㅏ ㅐ ㅑ ㅒ ㅓ ㅔ ㅕ ㅖ ㅗ ㅗㅏ ㅗㅐ ㅗㅣ ㅛ ㅜ ㅜㅓ ㅜㅔ ㅜㅣ ㅠ ㅡ ㅡㅣ ㅣ',' ') AS vowels,
           regexp_split_to_array(' ㄱ ㄲ ㄱㅅ ㄴ ㄴㅈ ㄴㅎ ㄷ ㄹ ㄹㄱ ㄹㅁ ㄹㅂ ㄹㅅ ㄹㅌ ㄹㅍ ㄹㅎ ㅁ ㅂ ㅂㅅ ㅅ ㅆ ㅇ ㅈ ㅊ ㅋ ㅌ ㅍ ㅎ',' ') AS finals,
           '{"ㄳ":"ㄱㅅ","ㄵ":"ㄴㅈ","ㄶ":"ㄴㅎ","ㄺ":"ㄹㄱ","ㄻ":"ㄹㅁ","ㄼ":"ㄹㅂ","ㄽ":"ㄹㅅ","ㄾ":"ㄹㅌ","ㄿ":"ㄹㅍ","ㅀ":"ㄹㅎ","ㅄ":"ㅂㅅ",
             "ㅘ":"ㅗㅏ","ㅙ":"ㅗㅐ","ㅚ":"ㅗㅣ","ㅝ":"ㅜㅓ","ㅞ":"ㅜㅔ","ㅟ":"ㅜㅣ","ㅢ":"ㅡㅣ"}'::jsonb AS compound
  )
  -- Hangul.search와 동일하게 완성형 및 복합 호환 자모만 펼친다.
  SELECT coalesce(string_agg(
    CASE WHEN chars[1] IS NOT NULL THEN
      initials[(ascii(chars[1])-44032)/588+1] ||
      vowels[((ascii(chars[1])-44032)/28)%21+1] ||
      finals[(ascii(chars[1])-44032)%28+1]
    WHEN chars[2] IS NOT NULL THEN compound->>chars[2]
    ELSE chars[3] END, '' ORDER BY ordinal), '')
  FROM jamo CROSS JOIN regexp_matches(value COLLATE "C",
    '([가-힣])|([ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄㅘㅙㅚㅝㅞㅟㅢ])|([^가-힣ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄㅘㅙㅚㅝㅞㅟㅢ]+)', 'g')
    WITH ORDINALITY AS segments(chars,ordinal);
$$;

ALTER TABLE catalog.packs
  ADD COLUMN autocomplete_display_name text GENERATED ALWAYS AS (regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) STORED,
  ADD COLUMN autocomplete_normalized_name text GENERATED ALWAYS AS (catalog.pack_search_normalize(name)) STORED,
  ADD COLUMN autocomplete_jamo text GENERATED ALWAYS AS (catalog.pack_search_jamo(catalog.pack_search_normalize(name))) STORED;
