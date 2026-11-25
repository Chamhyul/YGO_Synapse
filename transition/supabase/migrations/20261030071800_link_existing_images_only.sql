BEGIN;
-- 호출자는 GCS의 실제 기존 파일 목록에서 확인한 CIID만 전달한다.
-- 이 함수는 기존 수동 연결/공식 출처/그룹/_jp를 바꾸는 인터페이스가 아니다.
CREATE FUNCTION catalog.link_existing_images(p_cid integer,p_ciids integer[])
RETURNS TABLE(source_id bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_cid IS NULL OR p_cid<1 OR p_ciids IS NULL OR cardinality(p_ciids)>1024
    OR EXISTS(SELECT FROM unnest(p_ciids) n WHERE n IS NULL OR n<1) THEN
  RAISE EXCEPTION 'INVALID_EXISTING_IMAGE_INPUT' USING ERRCODE='22023';
 END IF;
 RETURN QUERY UPDATE catalog.artwork_sources s
 SET image_ciid=s.official_ciid,image_variant='base'
 WHERE s.cid=p_cid AND s.official_ciid=ANY(p_ciids)
 AND s.image_ciid IS NULL AND s.image_variant IS NULL
 RETURNING s.id;
END $$;
REVOKE ALL ON FUNCTION catalog.link_existing_images(integer,integer[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.link_existing_images(integer,integer[]) TO synapse_transition_crawler;
COMMENT ON FUNCTION catalog.link_existing_images(integer,integer[]) IS '크롤러 전용: 실제 기존 GCS 파일을 확인한 동일 CIID의 빈 이미지 연결만 base로 채움. 기존 수동값/공식키/그룹 변경 불가.';
COMMIT;
