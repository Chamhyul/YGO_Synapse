# 사용자 저장소 RTDB 통합 검사

`YGO_Synapse` 단일 저장소에서 사용자 저장 어댑터와 프로필·가입·설정/인벤토리 및 관리자 세션 HTTP 시험 연결, API 키·사용량·CORS·멤버십 원본/인증 진행/CSV·claims 잠금·관리 CLI를 실제 Firebase Admin SDK와 Realtime Database 에뮬레이터로 검사한다. 대상 라우트는 명시적 test/demo 설정에서만 RTDB를 선택한다. 기본 앱·일반 dev는 기존 저장소를 사용하며 이 구성은 운영 RTDB 연결·데이터 이전·전체 기능 전환 완료를 뜻하지 않는다. 운영 연결 준비 코드는 별도 단위 검사에서 합성 SDK로만 확인하고, 실제 운영 대상 등록 목록은 비워 둔다.

## 실행

저장소 루트에서 이미지를 빌드한 뒤 전용 검사 구성만 실행한다. `MAIN_IMAGE`로 검사할 로컬 태그 또는 고정 digest를 지정할 수 있다.

```sh
docker build -t ygo-synapse:local .
docker compose -f integration/user-storage/compose.yaml up --abort-on-container-exit --exit-code-from tests
# 성공/실패 후 이 검사 구성만 정리한다. 볼륨 삭제 옵션을 사용하지 않는다.
docker compose -f integration/user-storage/compose.yaml down
```

이미지는 빌드 중 고정 Firebase CLI의 RTDB 에뮬레이터 바이너리를 준비하며 Auth 에뮬레이터는 포함된 Firebase CLI로 실행한다. 검사 실행에는 외부 네트워크나 인증정보가 필요하지 않다. 기존 개발 서버·사용자 데이터 볼륨·운영 프로젝트·별도 Service/Cards 저장소에 연결하거나 이를 재시작하지 않는다.

## 격리와 설정

- Compose 프로젝트는 `ygo-user-storage-test`다. `emulators`와 `tests`만 전용 `internal` 네트워크에 연결하며 호스트 포트·볼륨·자격증명 마운트를 제공하지 않는다.
- 프로젝트는 `demo-user-storage`, RTDB namespace는 `demo-user-storage-default-rtdb`다. RTDB/Auth 에뮬레이터는 컨테이너 내부 `9000`/`9099` 포트를 사용하고 관리 UI는 실행하지 않는다. 데이터는 해당 실행의 컨테이너 수명 동안만 유지한다.
- 준비 검사는 DB namespace의 응답과 Auth config endpoint의200을 함께 확인한다. DB만 먼저 응답하는 시작 간극에서 claims 복구 검사가 Auth에 연결하지 못하는 상황을 피한다. 준비 실패는 테스트 시작을 막으며 운영 Auth로 대체하지 않는다.
- 검사 프로세스에만 `NODE_ENV=test`, `GCLOUD_PROJECT=demo-user-storage`, `USER_STORAGE_BACKEND=rtdb`, `FIREBASE_DATABASE_EMULATOR_HOST=emulators:9000`, `USER_DATABASE_URL=http://emulators:9000?ns=demo-user-storage-default-rtdb`를 명시한다. 일반 dev나 운영 `.env`에 이 검사 설정을 복사하지 않는다.
- 루트 RTDB Rules는 인증 유무와 관계없이 클라이언트 직접 읽기·쓰기를 거부한다. Admin SDK의 서버 접근은 Rules와 별개의 권한 경로이므로 에뮬레이터 성공을 운영 IAM 격리 증명으로 취급하지 않는다.
- 준비 상태 확인은 지정 namespace의 REST 응답을 사용한다. 읽기 거부 응답도 프로세스 준비 완료로 인정하며, 데이터 저장·직접 접근 차단은 별도 통합 검사에서 확인한다.

검사는 이미지 안의 `functions/test/userStorage.integration.js`·`inventoryParts.integration.js`·`inventoryApi.integration.js`·`inventoryRecovery.integration.js`·`userProfileApi.integration.js`·`adminSessionApi.integration.js`·`adminSessionStore.integration.js`·`adminRuntimeApi.integration.js`·`apiAccessApi.integration.js`·`apiAccessStore.integration.js`·`apiAccessCli.integration.js`와 아래 멤버십 검사들을 실행한다. 분할 저장은 선택 카드 접근 범위·전체/부분 동시 수정·다중 카드 공개 시점·위치 ID·초기화·저장 응답 유실·퇴역 노드 정리 실패를 검사한다. HTTP 검사는 실제 서버·라우트·저장소를 연결해 추가/이동/제거·가져오기·조회·초기화의 응답 호환과 집계·CID 상태·부분 접근·무변경 요청을 검사한다.

관리자 세션 검사는 합성 Auth/시각/실제 템플릿과 RTDB를 연결한다. 로그인·문서 접근·활동·로그아웃·만료·동시 수정/삭제와 기존 쿠키·응답 계약을 확인한다. 일반 `adminPages`/`adminBackend`가 사용하는 공통 runtime factory의 양쪽 HTTP 진입점도 검사하며 공지 서비스·오류/트래픽 집계는 실제 구현과 합성 백엔드를 사용한다. 실제 export에는 시험 의존성을 주입하지 않아503으로 차단되는지 확인한다. 운영 중계/실계정/외부 Storage·통계에는 접속하지 않는다. CSV는 합성 관리자 세션과 실제 RTDB 저장소를 연결하여 목록 미리보기·적용·재전송·권한 거부를 확인한다. 일반 export의 시험 설정은 계속503으로 차단한다.

프로필 HTTP 검사는 신규/동시 가입·재가입·서버 시각·기존 인벤토리 회원·설정 병합·닉네임·권한/저장 실패·초기화 시 프로필 보존을 검사한다. 로그인·App Check·카드 조회 등 외부 경계는 합성 의존성이며, 프로필 검사에서는 기존 Auth 처리 로직과 실제 RTDB를 연결한다. 이전 인벤토리 전용 검사의 Firestore 프로필은 합성 의존성으로 유지한다. 실제 계정/OAuth/claims 검증·운영 IAM·리전 지연·무료 사용량·실데이터 이관/복구를 증명하지 않는다. 임시 HTTP 포트는 검사 컨테이너의 loopback에만 열며 호스트로 공개하지 않는다. GitHub 검사 CI는 기존 일반·브라우저·카드·읽기 API 검사와 함께 이 구성을 실행한다.

공식 연결 기준은 [Realtime Database 에뮬레이터 연결](https://firebase.google.com/docs/emulator-suite/connect_rtdb)을 따른다. 실제 실행 결과·실패·한계는 프로젝트의 비공개 검증 기록에 남긴다.

## 합성 작업 결과 대조

저장 결과의 `operationId`는 내부 시도별 식별자다. 실패 후 업무 요청을 다시 보내기 전에 새 연결에서 확정 결과를 대조한다. 시험 에뮬레이터가 실행 중일 때 아래 CLI를 같은 전용 구성으로 실행한다. UID와 작업 ID는 해당 합성 실행에서 확인한 값으로 지정하며 운영 계정 데이터를 넣지 않는다. 기존 dev에는 접속하지 않는다.

```sh
# 기본은 읽기 전용. --help는 연결하지 않는다.
docker compose -f integration/user-storage/compose.yaml run --rm --no-deps tests node scripts/reconcile_inventory_operation.cjs --help
# <합성 UID>·<작업 ID>는 실제 시험 값으로 치환한다.
docker compose -f integration/user-storage/compose.yaml run --rm --no-deps tests node scripts/reconcile_inventory_operation.cjs --uid '<합성 UID>' --operation '<작업 ID>'
# 확정된 작업의 남은 정리만 수행한다. 미확정 요청은 보존한다.
docker compose -f integration/user-storage/compose.yaml run --rm --no-deps tests node scripts/reconcile_inventory_operation.cjs --uid '<합성 UID>' --operation '<작업 ID>' --recover
```

미확정 시도를 의도적으로 취소할 때만 `--recover --cancel-pending`을 함께 지정한다. 취소는 해당 시도의 이후 공개를 막으며 이미 확정한 업무를 되돌리지 않는다. 아직 저장 승인이 확인되지 않은 후보는 본문 대신 폐쇄 표식을 남겨 늦은 저장을 차단한다. `cleanup:fenced`의 표식과 작업 기록은 자동 삭제하지 않는다. 현재 참조·다른 작업·기록 없는 과거 후보는 보존한다. 새 연결 대조, 초기화 이후 성공 증거, 동시 취소/저장·반복 정리의 합성 장애 검증을 운영 복구 증거와 구분한다.

## API 접근과 관리 CLI 검사

API 접근 검사는 실제 HTTP·RTDB를 연결해 기존 getCardInfo 응답·키/Origin·오류·헤더·분/일 제한·unlimited·교체/중지 계약을 확인한다. 독립 SDK 연결에서 공유 쿼터, 지연 소비와 키 변경 경쟁, CORS 후보 작성 실패 및 현재 정책 재검사를 검사한다. 카드 읽기는 합성 자료로 한정하며 일반 경로의 로컬 Firestore 요구와 RTDB 시험에서 원격 카드 서버 차단을 유지한다.

관리 CLI 검사는 별도 Node 프로세스에서 `--rtdb-emulator`와 위 Compose의 test/demo 설정을 사용한다. 명시적인 `--apply` 전에는 DB/파일을 바꾸지 않는다. 합성 키의 발급·교체·중지, 대상 불일치 거부, DB 원문 미저장, 저장소 밖 새0600 파일·덮어쓰기/링크 거부·실패 시 원문 보존을 확인한다. 키 파일은 컨테이너 임시 폴더에서만 만들고 검사 후 삭제하며 내용은 출력하지 않는다. 운영용 API 키를 시험에 사용하지 않는다. 기존 Firestore 대상 옵션과 운영 연결은 이 검사에서 실행하지 않는다.

## 멤버십과 custom claims 검사

`membershipStore.integration.js`, `membershipApi.integration.js`, `membershipClaims.integration.js`, `membershipCsvStore.integration.js`, `membershipCsvAdminApi.integration.js`, `membershipCsvCli.integration.js`를 같은 격리 구성에서 실행한다. 멤버십 원본·nonce·CSV·잠금에는 실제 Admin SDK와 RTDB 에뮬레이터를 사용하며 Auth/App Check·Google/Discord·claims 쓰기는 합성 의존성을 사용한다. 외부 계정이나 실제 회원 CSV를 사용하지 않는다.

인증의 일회 소비·5분 만료·동시 설정 변경·다른 UID·localOnly, CSV 불변 후보/활성 포인터·동시 적용·재전송·슬롯 보존, claims의 기존 역할 보존·미확정 잠금·원본 버전 변화를 검사한다. 웹의 토큰 버전 비교·갱신과 같은 UID 재로그인 경계는 `scripts/membership_claims.test.js`의 합성 검사로 확인한다. 실제 Auth 토큰 발급/갱신과 운영 권한은 별도 검증 대상이다.

CSV CLI는 `--rtdb-emulator`를 반드시 명시한다. `--dry-run`은 파싱/대상 설정만 확인하며 적용 실행도 원본 CSV와 실제 보관 폴더를 변경하지 않는다. 운영 RTDB CLI는 지원하지 않는다. claims 결과가 미확정이면 자동 잠금 해제·TTL 재시도를 하지 않는다. demo 전용 복구 도구는 아래에서 시험한다. 운영 전에는 기존 claims writer/원격 요청 종료의 확인과 실환경 복구 절차를 검증해야 한다.

## 멤버십 claims 실패 대조·복구

`membershipClaimsRecovery.integration.js`는 실제 Firebase Admin SDK·RTDB/Auth 에뮬레이터와 별도 CLI 프로세스로 읽기 대조·동시 인계·오래된 finish 차단·역할 보존·실패 후 재대조/재복구를 검사한다. 운영 Authentication이나 OAuth에 접속하지 않는다. 이전 제공자 검사들은 계속 합성 Auth/OAuth를 사용한다.

시험 에뮬레이터가 실행 중일 때 아래 명령을 사용한다. UID/작업 ID는 자체 합성 실행에서 확인한 값만 넣고 실행 후 전용 구성을 정리한다.

```sh
# 도움말은 연결하지 않는다.
docker compose -f integration/user-storage/compose.yaml run --rm --no-deps tests node scripts/reconcile_membership_claims.cjs --help
# 기본은 상태 대조만 한다. Auth 시험 주소를 이 프로세스에만 지정한다.
docker compose -f integration/user-storage/compose.yaml run --rm --no-deps -e FIREBASE_AUTH_EMULATOR_HOST=emulators:9099 tests node scripts/reconcile_membership_claims.cjs --uid '<합성 UID>'
# 이전 writer와 그 Auth 요청이 모두 끝난 시험 상태에서만 명시적으로 복구한다.
docker compose -f integration/user-storage/compose.yaml run --rm --no-deps -e FIREBASE_AUTH_EMULATOR_HOST=emulators:9099 tests node scripts/reconcile_membership_claims.cjs --uid '<합성 UID>' --operation '<현재 작업 ID>' --recover --writers-drained
```

복구는 현재 관리자 역할·별도 claims를 보존하고 멤버십 요약만 맞춘다. `--writers-drained`는 이전 writer/원격 요청 종료를 확인한 실행자 조건이며 자동 종료·취소 기능이 아니다. 결과 일치·오래된 잠금만으로는 복구하지 않는다. 실패 시 기본 대조로 새 작업 ID와 상태부터 확인한다. 보고서의 `recovered`는 이번 복구 수행 여부이며 이후 동시 변경까지 중단시키는 보장이 아니다. 실제 운영 연결/권한·외부 요청 종료 증명·실계정 토큰 갱신은 별도 검증 대상이다.
