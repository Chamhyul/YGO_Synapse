# 전체 사용자 데이터 이전·대조·롤백 리허설

이 구성은 같은 `demo-user-migration` 프로젝트의 Firestore/Storage 원본과 RTDB 대상을 실제 SDK로 연결한다. 원본은 매번 새 합성 자료로 생성하며 운영 데이터·로컬 dev 데이터·사용자 파일을 받지 않는다. Auth 계정/역할과 카드 Firestore·공지/모델/일러스트 파일은 유지한다. 단계 표식은 시험 내 기준 저장소 전환을 모의하며 실제 Functions 배포/라우팅을 변경하지 않는다.

## 실행과 격리

```sh
docker build -t ygo-synapse:local .
docker compose -f integration/user-migration/compose.yaml up --abort-on-container-exit --exit-code-from tests
# 이번 검사 구성만 정리하며 볼륨 삭제 옵션은 사용하지 않는다.
docker compose -f integration/user-migration/compose.yaml down
```

전용 Compose는 `ygo-user-migration-test`이며 Firestore8080·Storage9199·RTDB9000·Auth9099를 internal 네트워크 안에서만 제공한다. 호스트 포트·개발 볼륨·자격증명 마운트가 없다. 모든 SDK 생성 전에 test/rtdb·demo 프로젝트·같은 로컬 호스트를 검증하고 기본 Firebase 앱·ADC를 사용하지 않는다. Firestore/Storage는 고정 시험 주소/인증의 Cloud SDK, RTDB/Auth는 별도 이름 앱의 Firebase Admin SDK를 사용한다. 클라이언트 직접 접근 Rules는 거부하며 서버 SDK 시험을 운영 IAM 증명으로 확대하지 않는다.

`rehearse_user_migration.cjs --help`는 연결하지 않는다. `--synthetic --run`을 함께 명시해야 새 합성 원본 생성·복사·대조·전환 후 변경·역변환을 수행한다. CLI의 실제 실행/오류/집계는 통합 검사에서 별도 프로세스로 검증한다. 실계정 UID·입력 파일·운영 옵션을 지원하지 않는다. 보고서는 단계/수량/불일치 수만 출력하며 원본과 영수증은 컨테이너 수명의 시험 DB에 보존한다.

## 범위와 단계

| 영역 | 리허설 원본 | RTDB 및 역변환 |
|---|---|---|
| 프로필·가입·동의·설정·멤버십 | users 문서 | 현행 profile codec, 시각·빈 map/배열/null·결측 보존. 전환 뒤 가입/변경도 기존 문서로 역변환 |
| 인벤토리 | 사용자별 Storage JSON | 기존 전체 reader가 읽는 위치 ID 형식으로 무손실 수용. 후속 전체/부분 API는 기존 분할 전환 경로 사용. 신규/변경/초기화 역변환 |
| 인증 진행 | Discord/YouTube nonce 해시 상태 | nonce/만료/localOnly 유지. 기존 consumed 상태를 재사용하지 않고 UID generation/completed를 보강. 원문 토큰/코드는 없음 |
| 관리자 세션 | AdminWebSessions | 같은 hash·UID·활동/만료. 활동·추가·삭제를 역변환 |
| API 접근 | key policy·usage·CORS | 현행 키/사용량 codec·origin 후보. 쿼터·unlimited·교체/중지·신규 키/Origin을 역변환 |
| CSV | 구형 명단·활성 포인터·완료/실패/부분 후보·멤버 문서 | 원본 mirror 보존과 불변 후보/활성 포인터/아카이브. 기존 결과의 등급 순서 보존. 신규·퇴역·실패 작업도 역변환 |
| 유지 영역 | 카드/작업 Firestore, Auth UID/역할/기존 claims, 파일 | 유지 영역의 합성 기준값·파일 generation을 대조. 멤버십 요약만 최신 원본으로 갱신하며 오래된 Auth 역할로 롤백하지 않음 |

코어는 `copying → copied → active → rollingBack → rolledBack`을 journal CAS로 관리한다. 원본의 updateTime/generation과 내용 지문을 기록하고 항목별 영수증으로 중단 후 재개한다. 복사 전후 원본 변경 또는 대상 변조는 활성화를 거부한다. 기존 원본은 복사/전환 단계에서 변경하지 않는다.

전환·롤백에는 이전 writer와 제출된 요청의 종료 확인 `writersDrained:true`가 필요하다. claims running/uncertain이 남으면 플래그만으로도 넘어가지 못한다. 이는 시험의 일관성 조건이며 운영 서버 종료·중단 시간·무중단 변경 포착 방식을 결정하거나 실행하는 기능이 아니다. 운영 전에는 별도 writer 경계와 변경 포착/재생 방법을 확정·검증해야 한다.

롤백은 RTDB 최신 값을 새 계획으로 고정한 뒤 원본의 이전 token/content 또는 이 run의 반영 영수증을 대조한다. 계획 밖 원본·새 원본 수정·재개 중 대상 변경은 덮어쓰지 않는다. Firestore는 문서와 영수증을 같은 transaction으로 기록하고 Storage upload는 generation 조건과 해당 객체의 metadata 영수증을 사용한다. Storage 삭제의 객체/별도 삭제 영수증 사이에는 공통 transaction이 없으므로 그 사이 중단은 자동 성공으로 추정하지 않고 대조 중단할 수 있다. DB 간 전체 transaction이나 모든 장애의 자동 복구를 보장하지 않는다.

## 검증과 한계

`userMigrationRehearsal.integration.js`는 전체 분야의 합성 자료, 전환 뒤 가입/수정/추가/초기화·Nonce/세션/키/사용량/CSV 변경, 새 연결 재개, 승인 응답 유실, 미지원 형식/대상 변조·원본 쓰기 경합, 미확정 claims 차단, 실제 사용자 HTTP 조회/설정과 별도 CLI를 검사한다. Auth/App Check/OAuth의 실제 로그인은 수행하지 않으며 사용자 HTTP 검사의 인증/등록 경계에는 명시적 시험 의존성을 주입한다.

원본 snapshot과 mirror/journal은 정합성 리허설을 위한 전체 자료이며 인벤토리는 최초에 호환 저장 형식을 수용한다. 서비스 읽기의 부분 범위/분할 저장과 별개다. 페이지25·합성 자료 및 전체 journal 갱신으로 검사하며 이 구성을 대규모 운영 이전 도구/비용 최적화/운영 백업으로 사용하지 않는다. 실제 자료의 전체 사전 감사·예외 타입·크기/시간/비용·증분 포착·복구 보존 정책·실환경 IAM/Rules·리전 지연·실계정/세션/토큰 검증은 남아 있다.

공식 연결 기준: [Firestore 에뮬레이터](https://firebase.google.com/docs/emulator-suite/connect_firestore), [Storage 에뮬레이터](https://firebase.google.com/docs/emulator-suite/connect_storage), [RTDB 에뮬레이터](https://firebase.google.com/docs/emulator-suite/connect_rtdb). 실행 결과는 AGENTS.md의 비공개 기록 진입점을 따른다.

## 변경 포착·재생과 writer 전환 시험

같은 전용 Compose가 `userWriterTransition.integration.js`도 실행한다. 기존 정적 전체 이전 리허설은 유지하며, 추가 코어는 명시적으로 주입한 adapter의 writer만 관리한다. 기존 서비스 요청·CLI·큐를 자동 연결하는 운영 전환 명령은 제공하지 않는다. `rehearse_user_migration.cjs`의 기존 합성 명령은 정적 이전 리허설 범위다.

writer 시험은 실제 Firestore transaction과 RTDB transaction에 논리 레코드/영수증을 같이 저장한다. 프로필·인벤토리·nonce·세션·키/쿼터/CORS·CSV의 논리 값, Timestamp·null·빈 배열/map·삭제·신규 자료를 전달한다. 자료는 `writerRecords`/`writerReference`의 시험 형식이며 기존 native 인벤토리 head/CSV 제어와 연결된 운영 저장 형식이 아니다. native 전체 형식/기능 호환은 기존 이전·사용자 저장소 통합 검사에서 별도로 다룬다.

명령은 업무 RPC 전에 `prepared → executing`으로 등록된다. 결과 확인 뒤 journal의 변경 기록과 완료 상태를 같은 CAS로 확정한다. 불명확한 요청은 영구 영수증으로 복구한다. Firestore/RTDB 취소 fence는 업무 transaction에서 취소 영수증을 생성하므로 늦게 제출된 동일 작업도 다시 쓰지 못한다. 이미 성공한 요청은 취소하지 않고 포착한다. 미확정 시간만으로 해제하지 않는다.

원본 복사 중 쓰기·삭제/재생성, 순서대로 증분 재생, 복수 SDK 자원 잠금, 이전 epoch 거부, 지연 RPC 동안 전환 거부, 업무/재생 응답 유실 뒤 새 SDK 연결 재개, 중복 재생, 대상 변조, 새 backend 쓰기의 역방향 전환을 검사한다. 새 route의 epoch로 기존 명령을 자동 재송신하지 않고, 명시적 작업 ID의 확정 반환값을 유지한다. 자원/기록 한도 검사는 네트워크 없는 단위 검사에도 포함한다.

Storage upload는 실제 에뮬레이터 객체의 generation 조건과 metadata receipt를 확인한다. 삭제 뒤 영수증이 없는 간극은 자료 부재로 성공을 추정하지 않고 전환을 차단한다. 이 Storage 시험 adapter는 native 역방향 projection/취소 fence를 제공하지 않는다. 실제 Auth claims writer는 이 코어에 연결되지 않았으며 기존 UID claims 잠금·실패 복구 검사는 유지한다. 운영 인벤토리/claims/CSV 등의 adapter, 모든 구버전·관리 도구·큐 writer의 참여, 대규모 분할 outbox/보존·성능·실환경 검증이 전환 선행 조건이다.

## 프로필 native writer와 기존 HTTP 연결

전용 Compose는 `userProfileWriter.integration.js`를 함께 실행한다. `createProfileWriterBinding`에 Firestore/RTDB SDK를 주입하며 기존 `users` 문서와 `users/{encodedUid}/profile` 저장 형식·코덱을 사용한다. 새 프로필 writer의 논리 reference를 만들어 기존 reader로 바꾸는 방식이 아니다. 시험 SDK의 컬렉션/RTDB 경로는 run별 namespace로 격리된다.

프로필 복사 중 설정/닉네임 수정·RTDB 이후 신규 가입/수정·역방향 전환, 두 SDK의 동시 가입/병합, 인벤토리-only 가입 판정, 기존 멤버십/시각/빈값 보존, 업무/projection ACK 유실 후 새 연결 재개, token 충돌 취소·재조회, 사용자 부모의 다른 필드 보존, 미확정/지연 요청 동안 전환 거부, native 취소 fence와 늦은 요청을 검사한다. Firestore 영수증의 관리 버전이 실제 저장 내용에 결합되고 `serverTimestamp`와 `updateTime` 차이에 의존하지 않는지도 검사한다.

HTTP 검사는 실제 repository selector·등록 service·가입/사용자 route·Express를 연결한다. Auth/App Check, 인벤토리/카드/claims와 외곽 시험 guard는 명시 합성 경계다. 동의 버전·가입 필수·허용 설정 키·닉네임·시각/응답·drain 중 기존 실패 응답과 전환 후 재요청을 확인한다. 실제 계정 로그인이나 전체 인벤토리/claims 전환을 대신하지 않는다.

별도 프로세스의 runtime 시험은 `USER_PROFILE_WRITER_MODE=emulator`, `USER_PROFILE_WRITER_RUN_ID=<32자리 hex>`, 이 Compose의 네 에뮬레이터/test/rtdb/demo 설정을 사용한다. SDK 생성 전에 접속 설정을 검사하고 시험 버킷/경로만 연다. 기본 export는 해당 플래그가 있으면503으로 거부한다. 운영 활성화 플래그로 사용하지 않는다. 설정 변경/종료/미확정 연결의 자동 교체는 허용하지 않는다.

Firestore에는 사용자 문서와 별도 메타정보/receipt, RTDB에는 사용자 부모 아래 profile과 별도 receipt가 있다. 메타정보/receipt/journal의 자동 삭제는 제공하지 않으며 업무와 receipt의 공간/보존·다운로드 비용은 운영 전에 평가한다. 시험 runtime의 프로필·인벤토리 공통 경계는 아래의 연결을 사용한다. 다른 업무/관리 writer·Auth/claims 외부 RPC·대규모 기록·운영 권한/Rules·실데이터 감사·실계정 전체 기능/복구 수용은 남아 있다.


## 인벤토리 native writer와 가입 의존성

같은 Compose의 `userInventoryWriter.integration.js`는 프로필과 인벤토리의 공유 journal/epoch, Storage 원본 읽기 및 불변 snapshot+Firestore head/receipt, RTDB partitioned planner/head CAS를 연결한다. 검사는 파일 단위로 순차 실행하여 같은 에뮬레이터의 독립 리허설 간 부하를 줄이되, 각 시나리오 안의 복수 SDK/지연 RPC 경합은 유지한다.

전체 수정·선택 카드 수정·초기화·양방향 재생, 선택 밖 본문 미조회/버전 유지, 초기화·재생성 뒤 늦은 변경 거부, 응답 유실의 receipt 복구, 가입 재확인·같은 UID 자원 대기, 최초 저장 전 취소와 native CAS 직전 다른 SDK fence, 이전 epoch 요청 거부를 검사한다. 실제 HTTP 추가/이동/폐기/7열 조회/초기화에는 기존 mutator와 native 저장소를 사용하고 Auth/App Check·카드 검색/claims만 합성으로 대체한다. 별도 프로세스는 실제 인벤토리 유틸·프로필 selector가 기본 Firebase app/ADC 없이 demo binding에 연결되는지 검사한다.

Storage 에뮬레이터는 stale generation 업로드를 승인할 수 있으므로 해당 조건을 시험의 원자성 근거로 사용하지 않는다. Storage 측은 불변 파일을 준비한 뒤 Firestore head+receipt transaction으로 공개한다. 기존 `users/{uid}/inventory.json`은 대조 원본이며 시험 writer의 최신 내용은 head의 manifest와 불변 카드 버전에서 복원한다. 구형 직접 reader/writer와 혼합하여 사용하지 않는다. 전환용 카드 token의 본문 지문을 선택 읽기와 전체 대조에서 검증하며 head 변경 없이 카드 본문만 변조된 경우도 활성화를 거부한다. RTDB의 기존 head/카드 형식은 유지하되 writer receipt의 보관 경로/복구는 이 binding에 속한다. 전환 중 참조 버전 GC는 하지 않는다.

일반 인벤토리/이식 export의 시험 플래그는 업무·Auth·운영 전달 전에 거부된다. fixture용 HTTP 주입을 일반 dev/운영으로 옮기지 않는다. 실제 GCS 조건부 저장·운영 데이터·전체 writer 활성화/관리 도구·Auth·리전 지연·크기/비용·GC·운영 롤백은 이 검사 성공으로 입증되지 않는다. 현재 저장 경계/한도는 사용자 저장소 설계 문서를 따른다.


## 인증 진행·멤버십·claims의 공통 writer

`userMembershipWriter.integration.js`는 공통 프로필·인벤토리 binding의 membership/claimsStorage를 사용한다. Firestore 인증 컬렉션과 RTDB UID 부모에서 nonce·멤버십·영구 receipt를 함께 커밋한다. 진행 중 nonce의 양방향 전환, localOnly/미가입·만료·교체/중복 완료, 복수 SDK 소비·승인 유실 복구·같은 DB 취소 fence를 검사한다.

Auth의 전체 claims는 demo Auth SDK로 확인하며 role/admin/다른 필드 병합·readback·시간초과 뒤 늦은 쓰기·명시 복구를 검사한다. RPC 제출 전 전환 외부 작업과 UID 잠금을 등록한다. 외부 인증 대기 중 drain은 새 업무를 거부하고 기존 요청의 범위 내 완료만 허용한다. UID 잠금 이동 간 장애도 예약 복구 ID를 재사용하며 결과 미확정 상태로 activation하지 않는다. 복구의 `writersDrained`는 이전 모든 앱/복구 writer/RPC가 실제 종료됐다는 실행자 확인을 별도로 요구한다. 시간 경과나 Auth 값 일치는 종료 증거가 아니다.

HTTP 검사는 기존 제공자 factory를 호출하며 인증/App Check·OAuth·YouTube CSV 응답만 합성 주입한다. 원문 OAuth 증명은 영구 기록에서 제외한다. 일반 export·아직 미참여인 관리자/키/CSV 도구는 시험 플래그에서 거부한다. 기존 기본 경로·UI·카드 Firestore·Storage 파일의 범위는 유지한다. 세대0이 아닌 nonce는 조용히 변환하지 않고 세대 이관 구현이 필요하다는 오류로 거부한다.

운영 DB 생성/연결, 실제 OAuth·계정/브라우저 토큰 갱신·Rules/IAM·사용량, 명시 연결 없는 일반 export와 나머지 관리 도구/큐/기존 배포 writer와 전환용 outbox/보존 규모는 별도 준비·승인·검증 대상이다. 이 구성의 성공을 전체 운영 전환 완료로 처리하지 않는다.


## 관리자 세션 native 전환

`adminSessionWriter.integration.js`는 같은 binding의 adminSessions를 사용한다. FS AdminWebSessions 본문과 metadata/receipt, RTDB 기존 세션 head+commitReceipt와 직전 영구 receipt 보관을 연결한다. 기존 세 필드와 쿠키 SHA-256 식별자는 유지한다. 관측 삭제는 token/backend/epoch를 대조하며 임의 cookie logout은 부재 자료를 만들지 않는다. 활동 갱신은 UID·만료·세대를 native CAS에서 확인한다.

복수 SDK의 단조 activity·logout/재발급·승인 유실 재대조·같은 DB 취소 fence·양방향 전환과 실제 관리자 pages/backend HTTP factory를 검사한다. 일반 export는 demo 설정/명시 binding·합성 의존성 미주입 시 거부한다. 로그인 쿠키 발급 중 요청을 등록하고 drain 중에도 새 hash를 기존 요청 자원에만 추가한다. Auth roles와 세션은 encoded account 자원으로 직렬화하며 UID 원문은 바꾸지 않는다. 성공 응답/쿠키는 요청 종료 뒤 전달한다.

Auth/세션 쿠키·현재 권한·운영 외부 통계/공지/CSV는 합성 의존성이며 실제 운영 Auth 쿠키/브라우저 증명이 아니다. native DB와 전환 코어는 실제 에뮬레이터 SDK다. 설정/SDK 장애의 운영 proxy/기존 저장소 대체를 허용하지 않는다. 기본 RTDB 세션 writer가 commitReceipt head를 덮어쓰지 못하는 검사와 익명/없는 cookie 무저장 검사도 포함한다. 운영용 outbox/보존 규모·다른 관리 writer·실자료/권한·첫 운영 전환 및 롤백은 별도 승인/검증 조건이다.


## API 키·사용량·CORS native 전환

전용 Compose는 `cardApiWriter.integration.js`를 함께 실행한다. 기존 Firestore 정책/사용량/CORS와 RTDB 키별 head를 같은 전체 binding의 journal/epoch에서 양방향 복사·재생한다. 동시 두 SDK 소비·quota/unlimited·교체/중지·UTC 창·실제 DB 콜백 시 만료·응답 유실 receipt 복구·늦은 소비 영구 취소를 검사한다. 복사 중 추가 키/사용량/중지를 재생하고 여러 키의 동일 Origin 합집합을 유지한다.

HTTP는 실제 Express/합성 카드 또는 scoped demo Firestore를 주입한 명시 factory로 검사한다. 기존 쿼리·JSON·CORS/쿼터/Retry-After·거부 시 미차감·카드 미발견 차감·요청 중 drain·종료 유실 시503을 검증하며 카드 조회를 수집/저장으로 확대하지 않는다. 별도 프로세스의 `--writer-emulator` CLI는 runtime의 run별 경로에서 미적용/발급/교체/중지·키 파일0600·원문 출력 차단을 검사한다. 파일은 컨테이너 밖 저장소 경로가 아닌 컨테이너 임시 폴더에 합성 값으로 만들고 정리한다.

고아 usage/CORS·출처 불일치·알 수 없는 FS 자료는 자동 정리 없이 이전을 거부하고, 기본 RTDB writer는 공통 receipt head를 덮어쓰지 못한다. 운영 API 키·카드 데이터·실제 브라우저/사용자·기존 배포·IAM/Rules·성능/무료 사용량/전송량과 outbox/GC 규모는 별도 검증 대상이다. 일반 export의 차단과 운영 대상 등록 목록은 유지한다.


## 멤버십 CSV native 전환

전용 Compose는 `membershipCsvWriter.integration.js`를 함께 실행한다. 같은 binding에서 초기 fallback 공개 revision·완료/실패/미확정 후보·이력과 신규 적용·동시 관리자·실제 CAS 만료·응답 유실/영구 fence·이력 보관/역전환을 검사한다. 451명의 합성 후보로 다중 배치 준비와 활성화 순서를 확인한다. 이는 최대5000명/장기 보관/운영 비용 검사가 아니다.

관리자 pages/backend의 실제 HTTP는 합성 Auth·scoped demo DB와 같은 CSV binding을 사용하여 preview/apply/status·중복 요청·CSRF·현재 권한·세션과 전환을 검사한다. YouTube의 명단 판정과 프로필 완료는 부모 요청에 CSV 자원을 추가하여 CSV 변경이 앞지르지 않는지 확인한다. 외부 OAuth/실계정/Auth 토큰 갱신은 입증하지 않는다. 별도 프로세스 CSV CLI는 --writer-emulator로 run별 현재 backend만 적용하고 dry-run 무접속·원본 임시 CSV 보존을 검사한다. 원본은 합성 컨테이너 /tmp 자료이며 실제 보관 폴더는 접근하지 않는다.

운영용 outbox/GC·Firestore 크기/최대 명단과 장기 이력·전송량/무료 사용량·기존 writer 종료/모든 관리 경로·Rules/IAM·실환경 첫 전체 전환/롤백은 별도 검증 조건이다. 일반 export/운영 전달과 실제 연결 등록은 열지 않는다.

## 공지·관리자 console 전환

전용 Compose는 `adminWriter.integration.js`도 실행한다. 공지 CRUD/동시 revision·손상 파일·native Storage metadata·양방향 DB 전환과 공통 외부 lease를 검사한다. 제출된 Storage 저장의 지연/시간초과/응답 유실·명시 drain/실제 종료 확인·현재 파일 대조·복구 실패 후 같은 ID 재개는 합성 Storage 장애로 검사한다. RPC를 자동 재전송하지 않으며 실제 GCS generation 조건/ACL 검증과 구분한다. 보존 PID 유틸은 실행 경로에 없고 scoped FS `AdminNoticeLocks` 잔존은 쓰기/전체 복사를 차단하며 원문을 보존한다.

관리자 pages/backend의 실제 HTTP는 같은 native binding의 공지 서비스를 사용한다. console 작업 envelope는 네 서비스 작업만 명시 factory에 연결하며 카드 작업/운영 proxy는 거부한다. 현재 권한/disabled·owner 전용 변경·Auth pagination·CSV·claims 병합과 request drain/종료 승인 유실을 검사한다. Auth 역할 읽기/변경은 demo SDK이며 토큰/쿠키 검증은 합성 주입이다. 운영 App Check·실계정/브라우저·기존 writer 실제 종료·장기 outbox/GC/규모·최초 전체 운영 전환/롤백의 증거로 사용하지 않는다.


## 전환 이력 보관과 hot 정리

`writerRoute.integration.js`는 원문과 통합 헤더의 같은 CAS 게시·GET1회 route 조회·구형 payload version1/2의 무변경 읽기/다음 CAS에서format3 갱신·응답 유실/새 SDK 대조·두 SDK의 동일revision CAS·헤더 지문/주소/revision/본문 손상을 검사한다. native journal은 head(format3 메타정보/제어)와 body(version1 typed 원문)를 갖는다. 일반 route 반환은 그대로이며 상세 inspect/historyStatus/업무/복구는 전체 원문을 대조한다. 헤더 누락은 전체 reader로 확인하고 손상된 새 기록을 부재로 숨기지 않는다. 구형 기록의 일반 상태 조회는 헤더 확인과 전체 reader로GET2회이며 읽기만으로 이관하지 않는다. 새 형식을 쓰기 전 참여 reader의 호환 배포와 구형 writer 종료가 필요하다.

`docker compose -f integration/user-migration/compose.yaml run --rm --no-deps tests node integration/user-migration/measure-writer-route.cjs`는 같은 신규 기록의 전체 읽기와 헤더 읽기를32개 순차 합성 표본으로 비교한다. GET 횟수·SDK payload·컨테이너 수신량·p95를 따로 보고한다. 전체 운영 부하/지연/청구·본문 전체 무결성 검사를 대신하지 않는다.

`measure-writer-header.cjs`는 빈 진행 상태/1KiB/64KiB 본문에서 모드별128회·5라운드와16회 준비 조회를 사용한다. 전체/route 순서를 번갈아 실행하고 라운드별 p50/p95의 중앙값과 SDK GET/payload를 출력한다. 분리 reader 기준 이미지에서는 도구만 읽기 전용으로 연결하고 통합 헤더 이미지에서도 같은 fixture/도구를 실행한다. 두 측정은 순차로 수행하며 실제 RTT/TLS/동시 운영/청구나 전체 표본p95를 입증하지 않는다.

`measure-writer-reuse.cjs`는 네트워크 없는 합성 snapshot에서 빈 진행 상태/128개1KiB 작업의 전체·route 읽기를 모드별300회·5라운드로 측정한다. 지문 함수의 호출 수·시간과 전체 변환 시간을 구분한다. 기존/신규 이미지에 동일한 도구와 CPU/메모리 제한을 적용하고 순차 실행한다. 측정 래퍼 비용을 포함하며 실제 SDK 지연은 별도 `measure-writer-header.cjs`로 확인한다. 후속 조회의 손상·잘못된 enum/의존성·본문 불일치 거부와 CAS 무변경/새 SDK 재개는 단위 및 `writerRoute.integration.js`에서 검사한다.

`writerHistory.integration.js`는 native 전체 binding에서 총128건을 넘는 프로필 변경/외부 요청·이전 ID/결과 보존·페이지 조회·양방향 전환, 큰 미재생 변경의 receipt 참조·재생 ACK 유실 재개, 보관 ACK 유실·두 SDK 정리 경합·불변 원문 충돌, format1의 원래 capture 순번 보존, 미확정/복구 부모 보존·종료 체인 보관, 손상 이력의 재생 차단을 검사한다. 단위 검사에는 ID 조회/정리 CAS 경합과 늦은 재생 응답·hot 공간 재시도/단일 초과 거부가 포함된다.

보관은 같은 scoped demo RTDB의 run별 profileWriterHistory에 기록하며 확인된 종료 이력만 hot에서 제거한다. 보관 원문·ID·native 업무 receipt/fence/인벤토리 본문을 삭제하지 않는다. hot128개/4MiB와 전체 baseline/expected/frozen snapshot·장기 보관 비용·보관 쓰기 지연/운영 처리량은 별도 한도/수용 대상으로 남는다. 이 검사는 실제 자료·운영 GC/Rules/IAM·전체 runtime 활성화/첫 운영 이전/롤백의 증거가 아니다.

신규 format2는 동일한 encoded 본문을 run별 bodies에 한 번 보관하고 참조한다. 요청/완료의 서로 다른 token·서버 시각은 보존하고 구형 format1은 그대로 읽는다. 본문 → 이력 → 요약의 서버 승인/재조회가 모두 끝난 뒤에만 hot을 정리한다. 같은 SDK 상세 조회 안의 공유 본문은 한 번 읽되 결과 객체는 독립 복원한다. 본문/요약 ACK 유실·복수 SDK·본문 손상/누락과 원문 보존을 실제 에뮬레이터에서 검사한다.

성공 CAS는 record store가 반환한 서버 확정 snapshot을 대조하고 동일 레코드의 별도 조회를 반복하지 않는다. 경합은 실제 저장 원문을 재조회한다. 이력 공개 후 본문은 실제 DB에서 다시 읽어 전체 지문을 확인하고, 미확정/새 SDK/잘못된 확정 snapshot/본문·요약 실패에는 hot을 유지한다. 최초 typed codec의 지문/크기와 복원 시 확인한 통계를 같은 호출 안에서만 재사용하며 get/page의 원문 응답에는 내부 통계를 넣지 않는다.

`history.page`는 원문 반환 계약을 유지한다. 신규 `summaryPage`는 summaries 경로만 읽고 ID/종료 상태/원문 지문/크기/확인된 세대·순번을 반환한다. `coverage:'indexed'`이므로 과거 미색인 기록을 포함한 전체 목록으로 오인하지 않는다. 명시적인 `indexPage`는 기본32/최대128개씩 원문을 대조하고 요약만 준비한다. 원문/본문을 삭제·덮어쓰거나 일반 조회에서 백필을 자동 실행하지 않는다. 운영에서는 구형 writer의 읽기 호환/종료와 색인 범위 확인이 필요하다.

신규 요약 payload v2는 ID/종류를 주소에서 복원하고 고정 필드/수치 상태·base64url 지문으로 간결하게 저장한다. 반환 요약은 기존 필드·상태·hex 지문과 같으며 원문/요약 지문과 주소를 함께 확인한다. 구형 범용 요약과 새 요약을 같은 목록에서 읽고 구형 불변 payload는 덮어쓰지 않는다. 주소 변경/변조·다른 확정 snapshot·이력 공개 직후 본문 누락과 hot 원문 유지도 검사한다. 새 요약을 쓰기 전 참여 reader의 v2 호환 배포가 필요하다.

`docker compose -f integration/user-migration/compose.yaml run --rm --no-deps tests node integration/user-migration/measure-history-references.cjs`는 같은 합성 원문의 format1/format2 저장량·원문/요약 목록 SDK payload·상세 읽기를 비교한다. 각 작업 본문은 다르고 요청/확정 본문만 같으며 요약 색인/참조 부가량도 신규 저장량에 포함한다. 작은 기록은 저장량이 증가할 수 있다. 직접 CAS 구형 fixture와 신규 저장의 지연/쓰기량을 동등한 비용 비교로 해석하지 않으며 운영 청구·전체 서비스·실계정 검증을 대신하지 않는다.


## 분할 복사 계획과 보관 비용

`writerPlan.integration.js`는 전체 native binding의 총4MiB 초과 합성 원문·분할 기대값/작은 frozen 참조·양방향 전환, Unicode/시각/빈값 보존·페이지/chunk/manifest 손상, 계획 게시/기대값 checkpoint ACK 유실·새 SDK 재개·늦은 baseline 응답의 epoch 보호를 검사한다. 대상 우회 변경과 원문/digest 누락은 자료를 자동 보정하지 않고 거부한다. native 신규 계획은 페이지 수집/재개를 사용하며, 키/참조 집합의 정렬 메모리·단일 논리 자료/명령4MiB/동시128개·실자료/운영 백필 처리량은 별도 검증 대상이다.

`docker compose -f integration/user-migration/compose.yaml run --rm --no-deps tests node integration/user-migration/measure-retention.cjs`로 별도 scoped demo 보관/계획 측정을 실행한다. JSON은 크기별 native get/transaction/확정·payload·컨테이너 수신·fixture 저장량/지연과 USD 규모 시나리오만 출력하며 원문을 출력하지 않는다. Linux Docker 전용이고 입력 환경은 connection guard가 검사한다. 운영 TLS/캐시/지역/부하·전체 서비스 비용/실제 청구와 구분한다. 일별 무료 다운로드는 다음 날/월 전체로 이월하지 않는다. 현재 비용 산정/한계는 사용자 저장소 설계를 따른다.


## 운영용 공통 연결의 실제 함수·도구 검사

`userWriterRuntime.integration.js`는 같은 공통 runtime의 production 선택 코드에 합성 registry/고정 run과 demo SDK를 주입한다. 기본 실제 함수 소스를 로드하고 가입·설정·닉네임·전체 조회·카드 추가/이동/차감/초기화, Discord/YouTube 진행·완료/claims, 관리자 pages 세션·활동·로그아웃·직접 함수/envelope·CSV, 카드 읽기 API의 키/쿼터/CORS, 키·CSV·claims·전환 관리 CLI를 양방향 전환에서 검사한다. 사용자 guard를 우회하지 않으며 Auth/App Check/OAuth/세션 쿠키는 합성이다. 서버 템플릿과 관리 통계의 실제 외부 요청·운영 인증/IAM·실계정·기존 writer 종료/첫 전환의 증거로 확대하지 않는다.

운영 HTTP는 누락 전환 상태를 자동 초기화하지 않는다. 현재 운영 registry는 비어 있다. 등록된 대상/고정 writer ID·관리형 서비스/작업 metadata 환경을 준비한 뒤에만 공통 관리 도구를 사용할 수 있다. `scripts/manage_user_writer.cjs --help`의 상태/초기화·복사/재생/활성화·복구 명령과 `--apply`/epoch/기존 writer 종료 확인 경계를 따른다. 실제 실행·대상 등록·배포·DB 생성·이전은 별도 승인 대상이다. 기존 인벤토리-only 복구/합성 이전 리허설 CLI는 계속 demo 전용이다.


## 원본 수집 페이지·진행점 재개 검사

`writerPlan.integration.js`는 drain 실패 후 원본 쓰기 `resume`도 검사한다. 부분 수집 진행점/transfer를 유지한 epoch 증가, 새 SDK/CLI의 재개 응답 유실 재시도, 이전·신규 epoch의 보관 변경 재생, 늦은 활성화 거부, executing 영수증 복구 후 재개, prepared CLI 취소와 가입·설정·전환/역전환을 demo SDK에서 확인한다. 종료 확인 플래그는 실제 Job/RPC 종료 증명이 아니며 운영 종료 확인은 별도 실행 절차다.

같은 `writerPlan.integration.js`는 페이지/진행점 ACK 유실과 새 SDK 재개, 마지막 확인 문서 다음부터의 조회, 지난 위치의 신규/수정/삭제 event 재생, 위치 변조·확정 페이지 누락의 차단/복원·같은 transfer ID 재개를 검사한다. native `snapshot()`을 검사에서 차단한 상태에서도 copy/activate/역전환이 동작하는지 확인한다. Storage의 실제 다음 페이지 토큰과 RTDB25개 페이지로 인벤토리-only 사용자를 보존하며, 미참여 writer가 지난 위치에 추가한 원본은 최종 대조에서 전환을 막는다.

`writerCollection.test.js`는 불변 수집 페이지와 작은 진행점 CAS의 승인 유실/경합·도중 본문 후보 보존·손상/누락을, `writerSnapshotSource.test.js`는 이름-only 목록/지연 본문·cursor/도메인 경계를 검사한다. 확정 원본 페이지 재조회 생략과 보관 본문/페이지 체인의 재검증은 구분한다. 키/참조 정렬의 임시 공간·RTDB 부모 페이지/단일 CSV 본문·실자료/운영 성능과 업무 영수증/이력의 장기 보존은 별도 수용 대상이며 실제 운영 이전·writer 종료를 증명하지 않는다.


## 제한 정렬·계획 사본 정리 검사

`writerReferenceSort.test.js`는 제한 묶음/병합 순서·우선순위·Unicode·임시 공간 초과/소비 중단의 정리를 검사한다. `writerPlanCleanup.test.js`와 `writerPlan.integration.js`는 읽기 전용 후보 집계·frozen/미분류 자료 보호·지난 epoch 사본만 제거·삭제 ACK 유실·새 SDK/같은 ID 재개·장벽 중 writer 차단·보호 참조 주입 거부·영구 퇴역 표식·정리 후 역전환을 확인한다. 실제 CLI의 미리보기/적용과 후보25개 페이지/작은 삭제 배치도 demo SDK에서 검사한다.

`node integration/user-migration/measure-reference-sort.cjs`는 network none Docker에서만 사용하는 합성 참조 CPU/임시 파일 측정이다. 1천·1만·10만 고유 키와25% overlay를 기존 Map 정렬/제한 병합 정렬로 순서 반전3회 비교한다. 결과에는 count/digest·샘플 heap/RSS 증가량·시간·묶음/독자 수·임시 파일 최대 점유량만 담으며 원문/UID를 출력하지 않는다. 실제 운영 DB 비용/지연·임시 파일의 배포 환경 메모리 과금·전 사용자 자료 규모를 증명하지 않는다. 계획 정리는 실제 DB/운영에서 자동 실행하지 않는다.
