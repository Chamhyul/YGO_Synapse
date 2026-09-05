# 공개 데이터 링크 동기화 및 일러스트 마이그레이션 구현 계획

> DB 구조와 일러스트 마이그레이션 부분은 [cards 구조 통합 마이그레이션](CARD_SCHEMA_MIGRATION.md)으로 대체한다. 아래의 숫자 언어 슬롯 저장 및 실패 후 다음 카드 진행 계획은 더 이상 적용하지 않는다.

## 1. 목적

다음 두 문제를 256MiB 메모리 한도 안에서 구조적으로 해결한다.

1. `getInitialData`가 공개 JSON 파일을 직접 다운로드·파싱하고 같은 데이터를 중복 응답하는 문제
2. `migrateCardIllustrationsTask`가 `ciid`만 필요함에도 일반 카드 상세 크롤러와 Cheerio 전체 파싱을 사용하는 문제

최종 상태에서는 서버가 공개 데이터 본문을 전달하지 않고 다운로드 링크와 버전 정보만 제공한다. 프런트엔드는 필요한 리소스만 Storage에서 직접 내려받아 검증한 뒤 로컬 캐시에 반영한다. 일러스트 마이그레이션은 전용 경량 파서로 `ciid`만 수집하고 기존 언어 슬롯의 일러스트 필드만 교체한다.

## 2. 현재 문제

### 2.1 `getInitialData`

현재 함수는 다음 파일을 Cloud Storage에서 내려받아 파싱한다.

- `public/cardNames.json`
- `public/packs.json`
- `public/rarityMapping.json`

그리고 같은 객체를 최상위 필드와 `masterCache`에 함께 넣는다.

```js
{
  cardNames,
  packData,
  rarity,
  masterCache: {
    cardList: cardNames,
    pack: packData,
    rarity
  }
}
```

객체 참조가 같더라도 JSON 직렬화 결과에는 본문이 두 번 포함된다. 요청 처리 중 Storage 응답 Buffer, 문자열, 파싱 객체, 최종 JSON 문자열이 겹쳐 존재할 수 있으며 전체 동기화 요청에서 메모리 사용량이 증가한다.

### 2.2 일러스트 마이그레이션

현재 Task는 카드 한 장당 10개 언어 페이지를 일반 카드 크롤러로 처리한다. 일반 크롤러는 다음 데이터를 모두 파싱한다.

- 카드명
- 팩 및 카드 번호
- 레어도
- 효과와 펜듈럼 효과
- 종류, 속성, 종족, 레벨, 공격력, 수비력
- 일러스트 `ciid`

마이그레이션에서 필요한 값은 `#thumbnail`의 `ciid`뿐이다. Cheerio DOM을 반복 생성하고 카드 두 장의 결과를 한 배치 커밋까지 보유하는 현재 방식은 목적에 비해 비용이 크다.

## 3. 목표 아키텍처

```text
브라우저
  └─ 공개 리소스 매니페스트 요청
       └─ getInitialData: URL·generation·updatedAt만 반환

브라우저
  ├─ 변경된 card manifest 직접 다운로드
  ├─ 변경된 pack manifest 직접 다운로드
  └─ 변경된 rarity mapping 직접 다운로드
       └─ 검증 성공 후 IndexedDB와 메모리 캐시 갱신

Cloud Task
  └─ 카드 1장 조회
       └─ 언어 페이지를 순차 다운로드
            └─ thumbnail 문자열에서 ciid만 추출
                 └─ 기존 언어 슬롯 [1] 교체
                      └─ 카드 저장 및 커서 갱신
```

## 4. `getInitialData` 단일 응답 구조

### 4.1 응답 계약

공개 데이터 본문과 `masterCache`를 모두 제거하고 다음 구조 하나만 사용한다.

```json
{
  "success": true,
  "schemaVersion": 2,
  "syncType": "storage-links",
  "serverTime": 1788512400000,
  "resources": {
    "cardManifest": {
      "url": "https://firebasestorage.googleapis.com/v0/b/.../o/public%2FcardNames.json?alt=media",
      "updatedAt": 1788512300000,
      "generation": "1234567890",
      "format": "card-manifest-v2"
    },
    "packs": {
      "url": "https://firebasestorage.googleapis.com/v0/b/.../o/public%2Fpacks.json?alt=media",
      "updatedAt": 1788512200000,
      "generation": "1234567880",
      "format": "packs-v1"
    },
    "rarity": {
      "url": "https://firebasestorage.googleapis.com/v0/b/.../o/public%2FrarityMapping.json?alt=media",
      "updatedAt": 1788512100000,
      "generation": "1234567870",
      "format": "rarity-langs-v1"
    }
  }
}
```

원칙은 다음과 같다.

- 응답에는 공개 데이터 본문을 포함하지 않는다.
- 리소스 키, URL, 버전 정보는 `resources` 아래에만 둔다.
- `lastUpdated: Date.now()`를 캐시 버전으로 사용하지 않는다.
- 각 리소스의 `generation`을 우선 버전으로 사용하고 `updatedAt`은 표시와 구형 캐시 비교용으로 사용한다.
- 운영 URL은 Firebase Storage Rules가 적용되는 `firebasestorage.googleapis.com` 다운로드 URL로 통일한다.
- 에뮬레이터에서는 현재 Storage emulator 다운로드 URL을 사용한다.
- URL에 generation 조건을 추가할 수 있으면 해당 generation의 불변 파일을 받도록 구성한다.

### 4.2 서버 변경

`getInitialData`는 각 파일에 `getMetadata()`만 호출한다. 다음 작업은 제거한다.

- `downloadPacksMetadata()`
- `cardNames.json`의 `download()`와 `JSON.parse()`
- `getRarityMappingFromStorage()`의 본문 다운로드
- `mapToRowArray()` 서버 변환
- `masterCache` 생성
- 최상위 `cardNames`, `packData`, `rarity` 본문 반환

공통 헬퍼 `getPublicResourceMetadata(path, format)`를 만들어 다음을 일관되게 반환한다.

- 다운로드 URL
- `updatedAt`
- `generation`
- 데이터 형식 식별자

파일이 없으면 전체 요청을 실패시키지 않고 해당 리소스를 다음처럼 표시한다.

```json
{
  "url": null,
  "updatedAt": 0,
  "generation": null,
  "format": "card-manifest-v2",
  "available": false
}
```

### 4.3 프런트엔드 변경

`applyPublicData()`를 다음 단계로 재구성한다.

1. `resources` 응답 형식을 검증한다.
2. IndexedDB에 저장된 각 리소스 generation을 읽는다.
3. generation이 다르거나 로컬 데이터가 없을 때만 해당 URL을 다운로드한다.
4. 다운로드한 JSON을 리소스별 스키마로 검증한다.
5. 검증 성공 후 IndexedDB에 데이터와 generation을 같은 트랜잭션으로 저장한다.
6. IndexedDB 저장 성공 후 메모리 캐시를 교체한다.
7. 실패한 리소스의 기존 캐시와 generation은 유지한다.

리소스별 검증 규칙은 다음과 같다.

#### 카드 매니페스트

```js
Array.isArray(data.names)
Array.isArray(data.numbers)
```

- 이름은 문자열만 허용한다.
- 번호는 문자열만 허용하고 대문자 정규화한다.
- 검증 성공 후 `CardListCache.persist()`에 전달한다.

#### 팩 목록

- 최상위 값은 배열이 아닌 객체여야 한다.
- 각 팩은 최소한 `name`, `locale`, `updatedAt` 형식을 검증한다.
- 검증 성공 후 `CardDataStore.masterJSON.pack`과 `packData` IndexedDB 키를 갱신한다.

#### 레어도 매핑

Storage 원본은 `{ "langs": { ... } }` 형식이다. 기존 서버의 `mapToRowArray()` 변환을 프런트 공통 함수로 이동한다.

- `langs["0"]`부터 `langs["10"]`까지 존재 여부와 배열 형식을 검증한다.
- 검증된 원본을 행 기반 배열로 한 번만 변환한다.
- 변환 결과를 `CardDataStore.masterJSON.rarity`와 IndexedDB에 저장한다.

### 4.4 다운로드 실패 처리

- 카드 목록 실패: 기존 자동완성 캐시를 유지하고 검색 API는 계속 사용할 수 있어야 한다.
- 팩 목록 실패: 기존 팩 캐시를 유지한다.
- 레어도 실패: 기존 레어도 매핑을 유지한다.
- 하나의 리소스 실패가 다른 리소스 적용을 롤백시키지 않는다.
- 네트워크 실패 시 generation을 갱신하지 않아 다음 동기화에서 자연스럽게 재시도한다.
- JSON 파싱 또는 스키마 검증 실패 시 원본 캐시를 덮어쓰지 않는다.

## 5. 응답 형식 전환 전략

구버전 호환 계층은 두지 않는다. 기존 `getInitialData` 응답을 즉시 링크 매니페스트 구조로 교체하고 같은 배포에서 프런트 호출부도 새 계약만 처리하도록 변경한다.

- 별도 버전 2 엔드포인트를 추가하지 않는다.
- `cardNames`, `packData`, `rarity`, `masterCache` 본문 필드를 즉시 제거한다.
- 프런트의 구형 응답 분기와 구형 요청 타임스탬프 파라미터를 제거한다.
- 새 응답이 아닌 경우 명시적으로 오류를 발생시켜 잘못된 캐시 갱신을 막는다.

## 6. 일러스트 마이그레이션 경량화

### 6.1 전용 수집 함수

일반 `crawlCardInPack()`을 호출하지 않는 전용 함수를 만든다.

```js
fetchIllustrationIds(cid, locale) -> Promise<number[] | null>
```

처리 과정:

1. 공식 카드 상세 URL을 `fetch` 또는 경량 HTTP 클라이언트로 요청한다.
2. 응답 문자열에서 `id="thumbnail"` 컨테이너 범위만 찾는다.
3. 해당 범위의 `ciid` 쿼리 값 또는 `thumbnail_card_image_n` ID를 추출한다.
4. 양의 정수로 변환하고 중복 제거 후 오름차순 정렬한다.
5. 카드 페이지가 유효한데 썸네일이 없으면 `[1]`로 간주할지 빈 배열로 둘지 실제 공식 페이지 표본을 검증한 후 결정한다.

전체 DOM을 만들지 않으며 카드명, 레어도, 효과, 스탯은 파싱하지 않는다.

### 6.2 오류 분류

다음 상태를 구분한다.

- `success`: 유효한 카드 페이지와 ciid 목록 확인
- `notReleased`: 해당 언어판 카드 페이지가 존재하지 않음
- `retryableError`: 타임아웃, 429, 5xx, 네트워크 오류
- `parseError`: 카드 페이지는 있으나 예상 HTML 구조가 아님

`retryableError`와 `parseError`에서는 기존 DB 값을 삭제하거나 빈 배열로 덮어쓰지 않는다. `notReleased` 처리 정책은 기존 언어 슬롯 보존 여부를 별도로 결정하고 테스트로 고정한다.

### 6.3 카드 단위 처리

Task 한 번에 카드 한 장만 처리한다.

1. `cards/{cid}` 문서를 읽는다.
2. 10개 언어를 순차 요청한다.
3. 성공한 언어마다 기존 언어 배열을 복사한다.
4. 복사한 배열의 `[1]`만 ciid 배열로 교체한다.
5. 카드 한 장을 즉시 저장한다.
6. 저장 성공 후 `lastDocId`, `processedCount`, `updatedCount`를 갱신한다.
7. 다음 Task를 제출한다.

Firestore의 언어 정보가 배열이므로 배열 요소 `[1]`만 field path로 직접 갱신하지 않고 해당 언어 배열 전체를 교체한다. 나머지 배열 값은 기존 문서에서 그대로 복사해 보존한다.

### 6.4 메모리 및 재시도 원칙

- 카드 한 장의 저장이 끝나기 전에 다음 카드를 읽지 않는다.
- 원본 HTML을 상태 객체나 실패 로그에 저장하지 않는다.
- 로그에는 cid, locale, HTTP 상태, 오류 분류만 남긴다.
- Task는 동일한 `runId + cid`에 대해 멱등해야 한다.
- 카드 저장과 커서 갱신 사이에 실패하면 같은 카드를 다시 처리해도 결과가 같아야 한다.
- 재시도 소진 카드는 별도 실패 컬렉션 또는 제한된 실패 ID 목록에 기록한다.
- 전체 순회 완료 후 실패 카드만 재처리할 수 있는 모드를 제공한다.
- 이미 `status: running`인데 활성 Task가 사라진 경우 관리자가 같은 run을 재개할 수 있어야 한다.

### 6.5 모듈 로딩 경량화

마이그레이션 서비스에서 다음 top-level 의존성을 제거한다.

- `cardScraper`
- Cheerio
- 일반 카드 저장 서비스 중 불필요한 부분

추가로 모든 Firebase 함수가 `functions/index.js`에서 무거운 라우트를 즉시 로드하는 구조를 조사한다. 단기적으로는 크롤러와 외부 연동 모듈을 실제 핸들러 실행 시점에 불러오는 지연 로딩을 적용한다. 장기적으로 메모리 격리가 필요하면 API, crawler/task, integration을 Firebase codebase 단위로 분리한다.

## 7. 테스트 계획

### 7.1 공개 데이터 매니페스트 서버 테스트

- 응답에 `cardNames`, `packData`, `rarity`, `masterCache` 본문이 없는지 확인
- 세 리소스가 `resources` 아래에만 존재하는지 확인
- URL 인코딩과 에뮬레이터 URL 확인
- metadata 조회 실패 시 다른 리소스가 정상 반환되는지 확인
- generation과 updatedAt이 정확히 전달되는지 확인

### 7.2 프런트엔드 테스트

- 로컬 generation이 같으면 다운로드하지 않음
- generation이 바뀌면 해당 리소스만 다운로드
- 세 리소스가 모두 변경된 최초 실행
- 한 리소스만 다운로드 실패하는 부분 실패
- 잘못된 JSON 및 잘못된 스키마 거부
- IndexedDB 저장 실패 시 timestamp/generation 미갱신
- 카드 자동완성, 팩 검색, 레어도 현지화가 새 구조에서도 동일하게 동작
- 페이지 재접속 후 IndexedDB 캐시 복원

### 7.3 일러스트 마이그레이션 테스트

- `1, 2, 3` 연속 ciid 추출
- `1, 9, 15` 불연속 ciid 추출
- 쿼리의 `ciid`와 이미지 ID fallback
- 중복 ciid 제거 및 숫자 정렬
- 언어별 서로 다른 ciid 배열 저장
- 404, 429, 5xx, 타임아웃 분류
- 실패한 언어가 기존 값을 덮어쓰지 않음
- 카드 저장 전 실패와 저장 후 커서 갱신 전 실패의 멱등 재처리
- 중단된 run 재개 및 실패 카드 전용 재처리

### 7.4 메모리 검증

- 경량 파서에 큰 실제 HTML 표본을 반복 입력해 RSS 추이를 기록한다.
- 카드 한 장 처리 전후 `process.memoryUsage()`를 진단 환경에서 측정한다.
- 전체 HTML이나 Cheerio DOM이 장기 참조에 남지 않는지 heap snapshot으로 확인한다.
- `getInitialData` 응답 크기가 메타데이터 수 KB 수준인지 확인한다.
- Firebase emulator 또는 별도 프로세스에서 각 함수의 cold-start RSS를 독립 측정한다.

## 8. 배포 및 롤백

### 배포 순서

1. Storage 공개 읽기 URL과 CORS를 개발·운영 환경에서 검증
2. 새 `getInitialData`와 프런트 다운로드·검증·IndexedDB 로직을 함께 배포
3. 실제 사용자 초기 동기화와 캐시 복원 확인
4. 경량 일러스트 Task 배포
5. 중단된 기존 마이그레이션 run을 재개하거나 새 run 시작

### 롤백

- 프런트엔드는 기존 IndexedDB 데이터를 삭제하지 않는다.
- 새 리소스 다운로드 실패 시 기존 캐시로 즉시 동작할 수 있어야 한다.
- 마이그레이션은 언어 슬롯의 기존 `[1]` 값만 별도 백업하거나 변경 전후 값을 감사 로그에 남긴다.
- 마이그레이션 중지는 state 문서의 상태 변경으로 가능해야 하며 이미 처리된 카드 데이터는 유효한 최종 형식이므로 되돌릴 필요가 없어야 한다.
- 새 응답에 문제가 있으면 서버와 프런트를 같은 이전 릴리스로 함께 롤백한다.

## 9. 완료 조건

- `getInitialData` 계열 응답에 공개 데이터 본문 중복이 없다.
- 서버는 공개 JSON을 다운로드하거나 파싱하지 않는다.
- 프런트가 세 리소스를 링크로 내려받고 기존 기능을 동일하게 제공한다.
- 리소스별 부분 실패가 기존 캐시를 손상시키지 않는다.
- 일러스트 마이그레이션이 Cheerio와 일반 카드 상세 파서를 사용하지 않는다.
- 마이그레이션이 카드 단위로 저장·체크포인트·재시도된다.
- 실제 불연속 ciid가 언어별 배열로 정확히 저장된다.
- 두 함수가 256MiB 설정에서 반복 실행되어도 메모리 초과가 재현되지 않는다.
