# YGO_Synapse_Cards

카드 DB 조회와 카드 목록·팩·레어도 파일의 metadata를 제공하는 내부 HTTP 서비스다. 독립된 package.json·lockfile·Dockerfile을 사용하며 기존 서비스 폴더를 가져오지 않는다. 현재 구현에는 수집·저장·관리·작업 큐의 독립 실행 전환이 포함되어 있지 않다.

현재 이 폴더는 `YGO_Synapse` 단일 저장소 안의 카드 모듈이다. 별도로 만들어 둔 두 비공개 저장소는 보존하며 이 폴더와 자동 동기화하지 않는다. `repository-publication.json`은 이전 분리 게시 준비 자료다.

## 저장소와 DB 역할

같은 Firebase 프로젝트에서 카드 데이터는 Firestore, 사용자·인벤토리는 Realtime Database로 관리하는 구조를 목표로 한다. Authentication과 파일용 Storage는 유지한다. 현재 사용자 데이터는 Firestore, 인벤토리는 Storage JSON이며 RTDB 전환은 아직 구현되지 않았다. 첫 운영 전환은 전체 기능·API 호환·데이터 정합성·권한·복구 검증을 충족해야 한다.

`src/`는 카드 코드 원본이고 Functions는 생성된 호환 패키지를 사용한다. 아래 독립 읽기 런타임은 선택적 연결·호환 검사 용도이며 같은 프로젝트의 DB 분리를 위해 필수로 운영 배포할 구성은 아니다.

## Docker 검사

이 폴더에서 실행한다. 검사에는 외부 네트워크·운영 자격증명·사용자 데이터가 필요하지 않다.

```sh
docker compose -f compose.test.yaml build
docker compose -f compose.test.yaml run --rm tests
```

## 실행 설정

| 환경변수 | 역할 |
|---|---|
| `CARD_READ_BACKEND=firestore` | 실제 SDK 읽기 사용 |
| `CARD_PROJECT_ID` | 카드 프로젝트. 기존 서비스 프로젝트로 자동 대체하지 않음 |
| `CARD_STORAGE_BUCKET` | 카드 파일 버킷 |
| `CARD_DATABASE_ID` | DB 이름. 생략하면 지정한 카드 프로젝트의 `(default)` |
| `CARD_SERVICE_AUTH=oidc` | Google 서명 ID 토큰 검사 |
| `CARD_SERVICE_AUDIENCE` | 호출 대상 audience |
| `CARD_SERVICE_CALLERS` | 허용할 호출 서비스 계정 이메일. 쉼표로 구분 |

값을 준비한 환경에서 `docker compose up --build api`로 실행하며 로컬 포트는5091이다. 자격증명 파일은 이미지나 기본 Compose에 연결하지 않는다. 실제 클라우드 호출은 실행 계정·IAM·네트워크 설정을 별도로 갖춰야 한다. 이 소스는 해당 자원을 생성하거나 데이터를 이전하지 않는다.

## 읽기 계약

- `POST /v1/cards/read`: `{cids:["42"]}` 또는 `{field:"names"|"numbers",value:"...",limit?:숫자}`. CID는 최대100개, 문자열 조회는300자까지다. 반환은 `{success:true,cards:[{cid,data}]}`이며 카드 이름·번호·info와 상세 응답용 이름/레어도 필드만 포함한다. 입력의 collection·경로·임의 조회 연산은 허용하지 않는다. 원격 미발견은 빈 배열, 장애는503이다.
- `POST /v1/resources/read`: 빈 객체. 카드 목록·팩·레어도3개 파일의 URL·generation·format을 반환한다. 쓰기 요청을 제공하지 않는다.
- `GET /healthz`: 프로세스 상태만 반환한다. DB·IAM·파일의 실제 접근 성공을 뜻하지 않는다.

서비스 간 호출은 [Google의 OIDC 서비스 인증 방식](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)을 사용한다. 합성 인증은 `NODE_ENV=test`, `CARD_READ_BACKEND=fixture`, `CARD_SERVICE_AUTH=fixture`가 모두 설정된 검사 전용 실행에서만 동작하며 실제 저장소를 연결하지 않는다.

`src/`의 나머지 카드 모듈과 `manifest.json`은 기존 Functions 호환 패키지의 소스이기도 하다. 현재 독립 서버가 노출하는 경로는 위 읽기 API뿐이다.

## 호환 패키지 전달

`tools/export-compat.cjs`는 이 폴더만으로 기존 서비스의 호환 패키지를 생성한다. 원본 수정 후 아래 Docker 명령의 출력 경로를 기존 서비스의 `functions/services/card-service/`로 지정한다. 출력 폴더 외에는 쓰기 연결하지 않는다.

```sh
docker build -t ygo-card-service:local .
docker run --rm --network none \
  -v /absolute/path/to/YGO_Synapse/functions/services/card-service:/out:rw \
  ygo-card-service:local node tools/export-compat.cjs --output /out --write
```

`--write`를 빼면 대조만 한다. 미등록 출력 파일을 발견하면 보존하고 실패한다. 생성본의 `release.json`은 패키지 버전·원본 SHA-256·읽기 API 버전을, `content-sha256.json`은 파일별 해시를 기록한다. 단일 저장소에서는 루트 `scripts/sync-card-service.cjs`로 원본·생성본을 직접 대조한다. 별도 저장소용 `card-service.lock.json`은 이 루트에 추가하지 않는다. 생성본은 직접 편집하지 않는다. 소스 버전 변경 시 기존 서비스의 전체 검사와 `integration/read/compose.yaml`의 두 이미지 통합 검사를 함께 수행한다.

## 게시와 고지

이 카드 폴더 안의 `.github/workflows/ci.yml`은 분리 당시 보존 자료이며 단일 저장소의 활성 워크플로가 아니다. 루트의 검사 CI는 Docker 검증만 수행하지만 기존 main 배포·PR 미리보기·일러스트 워크플로도 별도로 남아 있다. 커밋·푸시 전에 실행 조건을 확인한다. `.env.example`은 비밀값 없는 형식 예제이며 실제 계정 정보는 별도로 설정한다.

자체 코드에는 [AGPL-3.0-only](LICENSE)가 적용된다. [의존성 목록](legal/dependencies.json)과 [수집한 라이선스 원문](legal/dependency-license-texts.txt)을 함께 제공한다. 미설치 optional dependency와 원문 미수집 항목은 목록에 구분한다. 카드 이미지·텍스트·브랜드·사용자 데이터에 이 코드의 허락을 확대하지 않는다. 이 저장소는 카드 데이터나 모델 자산을 포함하지 않는다.

의존성을 변경하면 설치된 이미지에서 `node tools/dependency-notices.cjs /out`을 실행해 쓰기 연결한 출력 폴더에 고지를 다시 생성한다. Docker 이미지 이름과 실행 포트는 GitHub 저장소 이름과 별도로 유지한다.
