# 카드 중앙 일러스트 로컬 동기화 계획

## 1. 목적

Momobako가 제공하는 YGOPro 이미지 목록과 YGOCDB의 카드 매핑을 이용해 서비스에서 사용할 중앙 일러스트를 로컬에 내려받는다.

최종 이미지 파일은 애플리케이션의 기준 식별자인 KONAMI CID와 공식 일러스트 번호인 CIID를 조합해 다음 형식으로 저장한다.

```text
{CID}_{CIID}.webp
```

예:

```text
resources/illustrations/
├── 4007_1.webp
├── 4007_2.webp
├── 4041_1.webp
├── 4041_18.webp
└── 4837_1.webp
```

기본 일러스트도 예외 없이 `CIID=1`을 사용한다. 서비스의 `cards` 문서와 사용자 인벤토리에는 이미지 원본 패스코드나 별도의 이미지 매핑 필드를 추가하지 않는다.

## 2. 확정 정책

1. 다운로드 도구는 로컬에서 실행한다.
2. Momobako의 이미지 ID 목록 전체를 처리 대상으로 검토한다.
3. YGOCDB가 반환한 CID를 기준으로 운영 Firestore의 `cards/{cid}` 문서를 조회한다.
4. 프로젝트 DB에 문서가 없는 CID는 다운로드하지 않고 대기 내역에 기록한다.
5. 임시 패스코드를 사용하는 이미지는 다운로드하지 않고 대기 내역에 기록한다.
6. DB에 없는 카드의 펜듈럼 여부는 판별하지 않는다.
7. DB에 있는 카드만 같은 문서 조회 결과의 `info.properties`로 펜듈럼 여부를 판별한다.
8. 일반 카드는 Momobako의 `!art`, 펜듈럼 카드는 `!artp` 변환 결과를 다운로드한다.
9. 파일이 추가되거나 변경된 경우에만 다운로드하고, 기존 파일의 무조건적인 전체 재다운로드는 하지 않는다.
10. 매핑 불가, 충돌 또는 다운로드 실패 한 건이 전체 동기화를 중단시키지 않게 한다.

## 3. 데이터 소스

### 3.1 Momobako 이미지 메타데이터

```text
https://cdn.233.momobako.com/ygoimg/ygopro/metadata
```

메타데이터의 각 행은 이미지 파일명, 크기, 수정 시각, MD5를 제공한다.

```text
{imageId}.webp:{size},{mtime},{md5}
```

이 파일은 다음 용도로만 사용한다.

- 전체 원본 이미지 ID 열거
- 신규 이미지 발견
- 기존 이미지의 변경 여부 확인
- 원격에서 사라진 이미지 확인

`/ygopro/pics/metadata`는 제공되지 않으므로 `!art`와 `!artp` 결과의 변경 여부는 대응하는 `ygoimg/ygopro/metadata` 항목을 버전 기준으로 삼는다. 원격 원본 MD5는 변환 결과 파일의 MD5와 같다고 간주하지 않는다.

### 3.2 YGOCDB 카드 매핑

```text
POST https://ygocdb.com/api/v0/cardset
```

Momobako 메타데이터에서 얻은 이미지 ID를 최대 100개씩 전달한다.

```json
{
  "ids": [46986414, 46986415, 46986431]
}
```

대체 일러스트 응답 예:

```json
{
  "46986415": {
    "cid": 4041,
    "id": 46986414,
    "altart": 46986415
  }
}
```

필드의 의미는 다음과 같다.

- `cid`: 프로젝트 카드 문서 ID 및 최종 파일명에 사용할 CID
- `id`: 해당 카드의 현재 기본 패스코드
- `altart`: 요청한 대체 일러스트 이미지 ID

배치 응답에서 누락된 이미지 ID는 임의로 가장 가까운 패스코드에 연결하지 않는다.

### 3.3 임시 ID 변경 기록

```text
https://ygocdb.com/api/v0/idChangelog.jsonp
```

ID 변경 기록은 대기 사유와 이후 갱신 여부를 확인하는 참고 자료로 저장한다. 이번 정책에서는 임시 ID를 현재 공식 ID로 강제 치환해 이미지를 다운로드하지 않는다. 향후 공식 패스코드 이미지가 Momobako 메타데이터와 YGOCDB 매핑에 정상적으로 나타났을 때 신규 이미지로 처리한다.

### 3.4 운영 Firestore

대상 프로젝트와 컬렉션은 다음과 같다.

```text
project: ygo-synapse
collection: cards
document: cards/{cid}
```

로컬 서비스 계정의 운영 Firestore 읽기 권한은 확인됐다. 로컬 도구는 `functions/serviceAccountKey.json`을 명시적으로 로드한다. 이 파일은 Git에 포함하거나 클라이언트 코드에 노출하지 않는다.

## 4. 처리 파이프라인

### 4.1 1단계: 원격 상태 확보

동기화 시작 시 다음 자료를 내려받는다.

1. Momobako `ygoimg/ygopro/metadata`
2. YGOCDB `idChangelog.jsonp`
3. 필요하면 YGOCDB `cards.zip.md5`와 `cards.zip`

`cards.zip`은 이미지 묶음이 아니라 카드 데이터 JSON 묶음이다. 중앙 일러스트는 아래 변환 URL에서 개별 다운로드한다.

### 4.2 2단계: 변경 대상 계산

원격 metadata와 로컬 동기화 매니페스트를 `sourceImageId` 기준으로 비교한다.

| 상태 | 처리 |
|---|---|
| 로컬에 없는 ID | 신규 처리 대상 |
| 원격 MD5가 변경됨 | 갱신 처리 대상 |
| 원격 MD5가 동일함 | 다운로드 생략 |
| 원격에서 사라짐 | 파일을 삭제하지 않고 `sourceMissing` 기록 |
| 과거 대기 항목 | 현재 조건을 다시 검사 |

최초 실행에는 모든 metadata 항목이 신규 처리 대상이 된다.

### 4.3 3단계: 임시 패스코드 제외

이미지 ID 또는 YGOCDB가 반환한 현재 기본 `id`가 임시 패스코드라면 다운로드하지 않는다. 카드 패스코드는 개념적으로 8자리지만 Momobako 파일명과 YGOCDB의 숫자 응답에서는 앞자리 0이 생략될 수 있으므로, `1~8자리 양의 숫자`를 정식 패스코드로 취급한다. 9자리 선행 ID는 임시 패스코드로 분류한다.

```js
function isOfficialPasscode(value) {
  const text = String(value);
  return /^\d{1,8}$/.test(text) && Number(text) > 0;
}
```

다음 경우는 `TEMPORARY_PASSCODE`로 기록한다.

- YGOCDB의 현재 기본 `id`가 9자리인 경우
- 이미지 ID가 9자리 선행 ID이고 현재 공식 매핑으로 직접 확인되지 않는 경우
- `idChangelog`에는 존재하지만 현재 공식 이미지로 확정되지 않은 경우

숫자 길이만으로 확정하기 어려운 경계 사례는 다운로드하지 않고 `UNRESOLVED_TEMPORARY_STATUS`로 기록한다.

### 4.4 4단계: YGOCDB 배치 매핑

변경 대상 이미지 ID를 최대 100개씩 `cardset`에 전달한다. 반환된 항목만 후속 처리한다.

응답이 없는 ID:

```text
status = pending
reason = YGOCDB_MAPPING_NOT_FOUND
```

연속된 숫자라는 이유만으로 CID를 추정하지 않는다. 연속 규칙은 CIID 계산과 응답 검증에만 사용한다.

### 4.5 5단계: CID별 그룹화 및 Firestore 조회

YGOCDB 매핑 결과를 CID별로 먼저 그룹화한다.

```js
Map<CID, MappedImage[]>
```

같은 CID에 이미지가 여러 장 있어도 `cards/{cid}` 문서는 한 번만 읽는다. 고유 CID를 적절한 크기의 묶음으로 나누어 Admin SDK `getAll()`을 사용한다.

필요한 필드는 `info.properties`뿐이며 문서 ID는 스냅샷에서 얻는다.

```js
const refs = cidBatch.map(cid =>
  db.collection("cards").doc(String(cid))
);

const snapshots = await db.getAll(...refs, {
  fieldMask: ["info.properties"]
});
```

문서가 없으면 그 CID에 속한 이미지 전체를 생략한다.

```text
status = pending
reason = CID_NOT_IN_PROJECT
```

프로젝트 DB에 문서가 없는 경우 YGOCDB의 타입 정보를 이용해 펜듈럼 여부를 보완하거나 이미지를 미리 받지 않는다.

### 4.6 6단계: 펜듈럼 판별

존재하는 문서의 현재 스키마에서 다음 조건으로 판정한다.

```js
const isPendulum =
  snapshot.data()?.info?.properties?.includes("Pendulum") === true;
```

별도의 `array-contains` 전체 쿼리는 사용하지 않는다. CID 존재 확인을 위해 읽은 동일한 문서에서 판별한다.

### 4.7 7단계: CIID 계산

기본 일러스트는 항상 `CIID=1`이다.

```js
if (!record.altart) ciid = 1;
```

대체 일러스트는 다음 식을 사용한다.

```js
ciid = Number(record.altart) - Number(record.id) + 1;
```

예:

```text
CID      = 4041
id       = 46986414
altart   = 46986431
CIID     = 18
filename = 4041_18.webp
```

다음 값은 오류로 던져 전체 작업을 중단하지 않고 대기 내역에 기록한다.

- 정수가 아닌 값
- 기본이 아닌데 `CIID < 2`인 값
- 설정한 현실적 상한을 벗어난 값
- 같은 원본 ID가 서로 다른 CID 또는 CIID로 해석되는 값

```text
reason = INVALID_CIID_MAPPING
```

### 4.8 8단계: 중앙 일러스트 다운로드

일반 카드:

```text
https://cdn.233.momobako.com/ygopro/pics/{sourceImageId}.jpg!art
```

펜듈럼 카드:

```text
https://cdn.233.momobako.com/ygopro/pics/{sourceImageId}.jpg!artp
```

동시 요청 수는 낮게 제한하고 지수 백오프를 적용한다. HTTP `429`와 `5xx`는 재시도 대상으로, `404`는 대기 대상으로 분류한다.

다운로드 결과는 먼저 OS 임시 디렉터리에 저장한다. 다음 검증을 통과한 뒤 최종 경로로 원자적으로 이동한다.

- HTTP 성공 상태
- 비어 있지 않은 본문
- WebP 디코딩 가능 (`!art`/`!artp`의 실제 응답 형식)
- 일반 `!art`: 예상 크기 `256 × 256`
- 펜듈럼 `!artp`: 예상 크기 `290 × 216`
- 로컬 SHA-256 계산 성공

최종 경로:

```text
resources/illustrations/{cid}_{ciid}.webp
```

장시간 전체 다운로드가 중단돼도 재개할 수 있도록 정상·대기·실패 결과를 100건 처리할 때마다 로컬 매니페스트에 원자적으로 체크포인트한다. 다음 증분 실행은 체크포인트에 `ready`로 기록된 동일 MD5 파일을 다시 다운로드하지 않는다.

## 5. 충돌 정책

서로 다른 `sourceImageId`가 같은 `{cid}_{ciid}.webp`를 가리킬 수 있다.

1. 기존 파일과 신규 파일의 SHA-256이 같으면 중복으로 기록하고 기존 파일을 유지한다.
2. SHA-256이 다르면 자동 덮어쓰기하지 않는다.
3. 충돌 파일은 실사용 폴더 밖에 보관하고 매니페스트에 기록한다.

```text
data/illustration-sync/conflicts/
├── 4041_2__source-46986415.webp
└── 4041_2__source-legacy-id.webp
```

충돌 상태:

```text
status = conflict
reason = TARGET_CONTENT_MISMATCH
```

정상적인 원격 MD5 변경으로 동일한 `sourceImageId`가 갱신된 경우에는 충돌이 아니라 업데이트로 처리한다. 새 파일 검증에 성공한 후 기존 파일을 교체한다.

## 6. 로컬 동기화 매니페스트

애플리케이션 DB에는 매핑 데이터를 추가하지 않는다. 동기화 도구 전용 상태만 로컬에 저장한다.

권장 경로:

```text
data/illustration-sync/manifest.json
```

예시:

```json
{
  "schemaVersion": 1,
  "source": "momobako-ygopro",
  "lastStartedAt": 0,
  "lastCompletedAt": 0,
  "remoteMetadataEtag": "",
  "files": {
    "46986415": {
      "remoteSize": 0,
      "remoteMtime": 0,
      "remoteMd5": "",
      "cid": "4041",
      "ciid": 2,
      "target": "4041_2.webp",
      "transform": "art",
      "localSha256": "",
      "status": "ready",
      "lastCheckedAt": 0
    }
  }
}
```

이미지 수와 상태 이력이 커져 단일 JSON의 원자적 갱신이 부담되면 동일한 논리 구조를 SQLite로 이전한다. 최초 구현은 사람이 검토하기 쉬운 JSON으로 시작할 수 있다.

## 7. 대기 목록

대기 항목은 원인을 구분해 기록하되 이미지 실사용 폴더에는 파일을 만들지 않는다.

| reason | 의미 | 다음 실행 처리 |
|---|---|---|
| `TEMPORARY_PASSCODE` | 선행 공개용 임시 ID | 공식 8자리 ID 출현 여부 재검사 |
| `INVALID_SOURCE_ID` | 0 또는 지원 범위 밖의 이미지 ID | 원격 인덱스 갱신 여부 재검사 |
| `UNRESOLVED_TEMPORARY_STATUS` | 임시 여부 경계 사례 | YGOCDB 갱신 여부 재검사 |
| `YGOCDB_MAPPING_NOT_FOUND` | API가 이미지 ID를 반환하지 않음 | 배치 매핑 재시도 |
| `CID_NOT_IN_PROJECT` | 운영 `cards/{cid}` 문서 없음 | DB 자동 크롤링 반영 여부 재검사 |
| `INVALID_CIID_MAPPING` | 연속 ID 규칙에 맞지 않음 | 자동 추정하지 않고 검토 유지 |
| `REMOTE_IMAGE_NOT_FOUND` | 변환 이미지가 아직 없음 | 다음 동기화에서 재시도 |

대기 항목에는 최소한 다음 값을 남긴다.

```json
{
  "sourceImageId": "100458001",
  "cid": null,
  "reason": "TEMPORARY_PASSCODE",
  "firstSeenAt": 0,
  "lastCheckedAt": 0,
  "attempts": 1
}
```

대기 항목은 실패로 집계하되 전체 실행 상태를 실패로 만들지 않는다.

## 8. 증분 동기화

### 8.1 신규 이미지

1. metadata에 새 `sourceImageId` 발견
2. 임시 ID 여부 확인
3. YGOCDB 배치 매핑
4. `cards/{cid}` 존재 확인
5. 같은 문서에서 펜듈럼 여부 확인
6. CIID 계산
7. 중앙 일러스트 다운로드
8. `{cid}_{ciid}.webp` 저장
9. 매니페스트 갱신

### 8.2 기존 이미지 갱신

1. 동일 `sourceImageId`의 원격 MD5 변경 확인
2. 기존 매핑과 현재 YGOCDB 매핑을 다시 비교
3. 현재 `cards/{cid}` 문서 존재 및 속성 확인
4. `!art` 또는 `!artp` 재다운로드
5. 임시 파일 검증
6. 기존 대상 파일을 원자적으로 교체
7. 원격 MD5와 로컬 SHA-256 갱신

### 8.3 프로젝트 DB가 뒤늦게 갱신된 경우

과거 `CID_NOT_IN_PROJECT` 항목은 원격 MD5가 같더라도 매 실행마다 또는 별도 대기 재처리 단계에서 `cards/{cid}`를 다시 조회한다. 문서가 생겼다면 정상 다운로드 대상으로 전환한다.

### 8.4 임시 패스코드가 공식 패스코드로 전환된 경우

과거 임시 ID 파일을 강제로 이름 변경하지 않는다. 1~8자리 공식 이미지 ID가 metadata에 나타나고 YGOCDB가 현재 CID를 반환하면 새 항목으로 정상 처리한다. 과거 대기 항목은 `supersededBy`를 기록하고 완료 처리할 수 있다.

## 9. 실행 모드

로컬 스크립트는 다음 모드를 제공한다.

```text
--dry-run          다운로드와 파일 변경 없이 예상 결과만 출력
--full             전체 metadata를 재평가
--incremental      신규·변경·대기 항목만 처리
--retry-pending    대기 항목만 재평가
--quiet            항목별 로그 없이 요약만 출력
--cid 4041         특정 CID만 검증 또는 재처리
--concurrency 4    이미지 동시 다운로드 수 지정
```

기본 실행은 `--incremental`과 낮은 동시성으로 한다. 최초 실제 다운로드 전에는 반드시 `--dry-run --full` 결과를 확인한다.

## 10. 로그 및 실행 결과

콘솔 로그는 원본 ID, CID, CIID, 처리 결과를 포함한다.

```text
[매핑] 46986415 → CID 4041 / CIID 2
[저장] 4041_2.webp (!art)
[대기] 100458001 — TEMPORARY_PASSCODE
[대기] 12345678 → CID 23537 — CID_NOT_IN_PROJECT
[생략] 46986416 — 원격 MD5 동일
[갱신] 4007_1.webp — 원격 MD5 변경
```

완료 요약:

```json
{
  "metadataEntries": 0,
  "mappedImages": 0,
  "downloaded": 0,
  "updated": 0,
  "unchanged": 0,
  "pendingTemporary": 0,
  "pendingMissingCid": 0,
  "pendingUnresolved": 0,
  "conflicts": 0,
  "failedDownloads": 0
}
```

## 11. 검증 계획

### 11.1 단위 검증

- metadata 행 파싱
- 앞자리 0이 생략된 1~8자리 정식 ID와 9자리 임시 ID 구분
- 기본 일러스트의 `CIID=1`
- 대체 일러스트의 CIID 계산
- 잘못된 CIID 범위 거부
- CID별 그룹화
- Firestore 문서 없음 처리
- `info.properties`의 Pendulum 판별
- 원격 MD5 비교
- 동일 대상 파일 충돌 판별
- 대기 항목 재처리

### 11.2 표본 검증

다음 카드는 최초 구현 검증 표본으로 사용한다.

| 카드 | 검증 목적 |
|---|---|
| 블랙 매지션 | 18개 연속 일러스트와 `CID_CIID` 순서 |
| 푸른 눈의 백룡 | 다수 대체 일러스트 |
| 융합 | 기본·대체 일러스트 및 별도 패스코드 경계 |
| 죽은 자의 소생 | 기본 ID 방향이 외부 소스마다 다른 사례 |
| 해피의 깃털 | 소수 대체 일러스트 |
| 펜듈럼 카드 표본 | `!artp` 선택과 `290 × 216` 검증 |
| 최근 선행 공개 카드 | 임시 패스코드 대기 처리 |
| DB 미등록 CID | 자동 크롤링 이후 재처리 |

표본마다 최종 파일을 육안으로 확인해 공식 CIID 순서와 이미지가 일치하는지 검증한다.

### 11.3 운영 DB 안전 검증

- 최초에는 `--dry-run --full`만 실행한다.
- 운영 Firestore에는 읽기만 수행한다.
- 사용자 컬렉션과 카드 문서는 수정하지 않는다.
- 서비스 계정 키 경로와 권한을 실행 전에 검사한다.
- 이미지 출력 디렉터리가 예상 경로인지 확인한 뒤 실제 다운로드를 허용한다.

## 12. 구현 순서

1. metadata 파서와 로컬 매니페스트 구현
2. YGOCDB `cardset` 100개 배치 매핑 구현
3. 임시 패스코드와 매핑 불가 대기 처리 구현
4. 운영 Firestore CID별 배치 조회 구현
5. 펜듈럼 판별과 CIID 계산 구현
6. `!art`/`!artp` 스트리밍 다운로드 및 이미지 검증 구현
7. `CID_CIID` 원자적 저장과 충돌 처리 구현
8. 증분 갱신과 대기 항목 재처리 구현
9. 단위 테스트 작성
10. 표본 카드 `--dry-run` 검증
11. 표본 카드 실제 다운로드 및 육안 검증
12. 전체 `--dry-run --full` 결과 검토
13. 전체 최초 다운로드
14. 두 번째 증분 실행에서 불필요한 재다운로드가 없는지 확인

## 13. 완료 조건

- 정상 처리된 모든 파일이 `resources/illustrations/{cid}_{ciid}.webp` 형식이다.
- 기본 일러스트는 모두 `_1`이다.
- 펜듈럼 카드만 `!artp`를 사용한다.
- 임시 패스코드는 다운로드되지 않고 대기 내역에 남는다.
- 프로젝트 DB에 없는 CID는 다운로드되지 않고 대기 내역에 남는다.
- 신규·변경 이미지 외에는 다시 다운로드하지 않는다.
- 갱신 실패 시 기존 정상 파일을 보존한다.
- 동일 대상의 서로 다른 이미지 충돌을 자동 덮어쓰지 않는다.
- 운영 Firestore에는 쓰기가 발생하지 않는다.
- 애플리케이션 카드 및 인벤토리 스키마를 변경하지 않는다.
