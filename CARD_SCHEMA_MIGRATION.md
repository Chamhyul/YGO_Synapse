# cards 문서 구조 및 일러스트 통합 마이그레이션

이 문서는 기존 일러스트 마이그레이션 계획의 DB 구조/진행/실패 정책을 대체한다.

## 저장 구조

```js
{
  schemaVersion: 2,
  names: ['블랙 매지션', 'Dark Magician'], // 기존 검색 필드 유지
  numbers: ['…'],
  updatedAt: 0,
  info: {
    ko: {
      name: '블랙 매지션',
      ciid: [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17],
      packs: { '카드번호': ['팩 이름', '레어도'] },
      text: '카드 텍스트',
      text_pen: ''
    },
    card_type: 'Monster',
    properties: ['Normal'],
    lv: 7,
    attribute: 'DARK',
    race: 'Spellcaster',
    atk: 2500,
    def: 2100
  }
}
```

- 언어 순서 대응: `0→ko, 1→ja, 2→ae, 3→cn, 4→en, 5→de, 6→fr, 7→it, 8→es, 9→pt`.
- 언어 필드는 배열 대신 `name`, `ciid`, `packs`, `text`, `text_pen` 맵이다.
- `ciid`는 실제 확인한 양의 정수 배열이다. 과거 종수로 `[1…n]`을 만들어내지 않는다. 미확정 종수는 변환 시 `null`로 표시하고 공식 페이지 재수집으로 확정한다.
- `packs`는 카드 번호 키와 기존 팩 이름/레어도 배열을 유지한다. 배열의 직접 중첩은 발생하지 않는다.
- `10→card_type`: Monster / Spell / Trap.
- `11→properties`: 몬스터/마법/함정 모두 하나의 배열에 기존 분류 코드를 공식 영문 표현으로 변환한다. 예: Xyz, Pendulum, Quick-Play Spell, Counter Trap.
- `12→lv`: 레벨/랭크/링크 수치를 모두 하나의 필드에 기록한다. 카드 종류에 따라 키를 분리하지 않는다.
- `13→attribute`, `14→race`, `15→atk`, `16→def`, `17→pendulum_scale`.
- 공격력/수비력의 기존 `-1`은 공식 표기 `?`로 저장한다. 값 0과 미수집(필드 없음)은 구분한다.
- 알 수 없는 분류 코드는 임의로 버리지 않고 변환 오류로 중단한다.

## 읽기와 쓰기

일반 크롤러의 저장도 `cardSchema.toStoredInfo()`를 거친다. 검색/상세/필터/팩/자동 크롤링/카드 번호 보완에서 새 구조를 읽는다.
크롤러와 화면 내부의 숫자 슬롯은 `toRuntimeInfo()` 변환 경계에서 유지한다. 따라서 프론트 API 사용 방식과 IndexedDB 캐시는 그대로 동작한다.
이전 DB 문서는 전체 순회 중에만 읽기 대상으로 지원한다. 마이그레이션은 `info` 전체를 교체해 숫자 키를 제거한다.

## 실행과 진행 상태

기존 관리자 POST `migrateCardIllustrations`를 사용한다. 상태 문서는 `system/cardIllustrationsMigration`이다.

- 새 작업에 `targetSchemaVersion: 2`를 기록한다.
- 과거 일러스트 전용 run의 커서는 재사용하지 않는다. 새 run으로 첫 문서부터 다시 처리한다.
- Task는 runId와 targetSchemaVersion을 모두 확인한다. 이전 run 작업은 무시한다.
- 문서 ID 오름차순으로 한 장씩 조회한다.
- 언어별 공식 페이지를 순차 조회해 ciid를 확보한다.
- Firestore 트랜잭션으로 최신 문서를 다시 읽고, 구조를 변환한 뒤 성공한 ciid만 적용한다. 네트워크 대기 중 갱신된 이름/팩/텍스트와 다른 최상위 필드를 보존한다.
- 한 문서 저장이 성공한 뒤 커서와 누적 건수를 기록하고 다음 Task를 등록한다.
- 언어 조회 또는 저장 실패는 `status: failed`, `failedDocId`, `lastError`로 기록하고 중단한다. 커서는 이동하지 않는다.
- 같은 관리자 시작 API를 호출하면 실패한 v2 run은 기존 커서부터 재개한다. running 상태가 10분 이상 정체돼도 재개할 수 있다.
- 총 문서 수를 매번 읽지 않는다. Cloud Logging에 문서 경로/이름/언어/ciid/저장 결과/누적 처리 건수를 한국어로 표시한다.

## 검증 및 배포

- 변환 왕복으로 화면에서 받는 이름/팩/효과/분류/스탯 보존을 검증한다.
- 불연속 ciid, 언어별 차이, Xyz/Link, ATK ?, 0, 미확정 종수를 검증한다.
- Firestore Emulator 실제 저장/읽기로 직접 중첩 배열 오류가 없는지 검증한다.
- 배포 후 관리자가 통합 마이그레이션을 시작한다. 배포 자체가 전체 DB 변환을 실행하지는 않는다.
- 실행 완료 시 `status: completed`와 마지막 문서, 누적 처리/저장 건수를 확인한다.
- 기존 문서의 숫자 키를 제거하는 데이터 변경이므로 운영 실행 전 백업을 권장한다.
