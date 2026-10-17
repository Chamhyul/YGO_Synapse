# 공개 소스 다운로드·실행 안내

## 배포 준비 소스

[2026-10-17 전체 서비스 준비 소스](../public/legal/ygo-source-prepared-20261017-full-release.tar.gz)와 [SHA-256](../public/legal/ygo-source-prepared-20261017-full-release.sha256)을 제공합니다. 관리자 설정·카드 화면·RTDB 공통 백엔드·요청 밖 이력 정리를 포함한 전체59개 Functions와 Hosting을 같은 검토 소스에 맞추는 묶음입니다. 기존 프로젝트의 운영 대상 등록·계정·환경·Secret·큐·예약 설정을 유지하며 데이터 이전·계정 권한 변경·관리 전환 Job 실행을 포함하지 않습니다. 카드 화면의 운영 저장은 연결하지 않았습니다.

[2026-10-17 요청 밖 이력 정리 준비 소스](../public/legal/ygo-source-prepared-20261017-history-worker-v14.tar.gz)와 [SHA-256](../public/legal/ygo-source-prepared-20261017-history-worker-v14.sha256)을 제공합니다. 등록·제거의 완료 영수증과 포착은 동기로 확정하고, 완료 기록 보관은 분당 예약 함수 `compactUserWriterHistory`가 기존 Job 계정으로 처리합니다. 기존 hot 건수·용량 예약과 한계 도달 시 동기 보관, 재생·복구 계약을 유지합니다. 반영 대상은 등록·제거2함수·신규 예약 함수·소스 고지 Hosting이며 기존 관리자 배포·나머지 함수·전환 Job은 보존합니다. 소스 생성 자체는 배포나 운영 성능의 증거가 아닙니다.

[2026-10-17 관리자 설정·카드 편집 준비 소스](../public/legal/ygo-source-prepared-20261017-admin-pages.tar.gz)와 [SHA-256](../public/legal/ygo-source-prepared-20261017-admin-pages.sha256)을 제공합니다. 소유자 전용 관리자 계정 조회·지정·해제와 카드 검색·화면 내 초안 편집을 포함합니다. 카드 운영 저장은 연결하지 않았습니다. 반영 대상은 `adminPages`, `manageAdminRole`, `adminHandleOperationRequest` 및 Hosting이며, 등록·제거 함수의 기존 v13과 다른 함수의 기존 v9 및 전환 Job v4는 유지합니다. 실제 관리자 권한 변경이나 사용자 데이터 이전을 소스 준비 단계에서 실행하지 않습니다.

[2026-10-17 초기 준비·전환 확정 최적화 준비 소스](../public/legal/ygo-source-prepared-20261017-connection-cas-v13.tar.gz)와 [SHA-256](../public/legal/ygo-source-prepared-20261017-connection-cas-v13.sha256)을 제공합니다. 기존 프런트엔드·API·저장 형식·복구 기능을 유지하면서 새 RTDB 인벤토리 명령의 자원 잠금과 실행 소유권을 같은 서버 CAS로 확정합니다. 업무 저장 전 승인과 완료 기록의 별도 확정을 유지하며, ACK 유실·동일 ID 실행 경합은 기존 영수증 대조/복구를 사용합니다. 동일한 journal 원문의 변환 제안을 재사용하고 등록·제거 인스턴스의 동기 SDK 준비를 시작 단계로 앞당깁니다. 이번 반영 대상은 등록·제거 함수이며 다른 함수는 이전 v9, 전환 Job은 기존 v4를 유지합니다. 준비 소스 생성 자체는 운영 배포나 전체 지연 해결 증명이 아닙니다.
- `functions/`: 같은 검토 묶음의 함수·관리자 템플릿·카드 호환 패키지와 잠금 의존성입니다. 카드 원본은 함께 제공하는 `card-service/src/`이며 `scripts/sync-card-service.cjs`로 호환 패키지를 재생성합니다.
- `public/`: 프런트엔드의 HTML·CSS·JavaScript와 제3자 고지입니다. 자체 호스팅한 라이브러리·WASM·DRAW2 ONNX 모델은 제3자 고지와 함께 제공합니다. 사용자 데이터·게임 일러스트 원본·제작 출처 미확인 앱 아이콘은 제외합니다.
- `package.json`, `package-lock.json`, `scripts/`: 공지 편집기의 편집 원본·빌드 입력, 포함된 관리·고지 도구입니다. 각 lockfile을 유지합니다.
- `firebase.json`, Rules, Job Dockerfile·진입점: 검토 소스의 실행에 필요한 설정과 코드입니다. 기존 운영 프로젝트를 대상으로 그대로 실행하지 말고 자신의 프로젝트·대상 등록·실행 계정으로 설정합니다.
- `SOURCE_MANIFEST.json`: 파일별 출처·SHA-256·기준 배포 묶음 지문과 제외 범위를 기록합니다. 실제 운영 배포 generation이나 사용자 원문을 포함하지 않습니다. 새 압축본·체크섬 및 이전 압축본은 압축 내부에 중첩하지 않습니다.

## 수정·실행

1. Node.js 24와 해당 아키텍처를 지원하는 Docker 환경을 준비합니다. 루트와 `functions/`에서 각각 `npm ci`로 잠금 의존성을 설치합니다. 원본 모델·WASM과 네이티브 패키지에는 서로 다른 구성요소의 조건이 적용됩니다.
2. 공지 편집기는 `scripts/admin_notice_editor.js`를 수정한 뒤 루트에서 `npm run build:notice-editor`로 다시 만듭니다. 카드 공통 코드는 `card-service/src/`를 수정한 뒤 `node scripts/sync-card-service.cjs --write`와 쓰기 옵션 없는 대조를 실행합니다.
3. 자신의 Firebase 프로젝트와 Google/Discord 연동·App Check·Secret Manager·실행 계정을 설정합니다. 웹 프로젝트 ID·API 주소·OAuth 복귀 주소 등 원본의 서비스 식별자를 자신의 환경에 맞춥니다. `.env`·Secret·키·토큰은 제공하지 않습니다.
4. 사용자 저장소 전환 코드는 같은 Firebase 프로젝트의 카드 Firestore, 사용자·인벤토리 RTDB, Authentication, 파일 Storage를 사용합니다. Functions와 Job의 등록 대상·run ID·환경을 맞추고, 초기 제어 상태와 기존 자료의 이전·대조·복구 절차를 준비한 후 사용합니다. 소스만 복사했다고 업무 자료가 이전되지는 않습니다.
5. 이미지 기능에는 본인이 사용할 수 있는 이미지와 CID/CIID 인덱스가 필요합니다. 제공한 모델·코드의 조건과 게임 일러스트의 권리는 구분됩니다. 제외한 아이콘은 사용할 수 있는 자산으로 교체합니다.
6. 자체 환경의 검증을 마친 뒤 필요한 Hosting·함수·규칙만 선택해서 배포합니다. `/api/illustrations/**`와 `/admin`의 Hosting rewrite는 대응 함수와 함께 검토합니다. Docker 실행 자체가 운영 API·DB 접근을 격리하는 것은 아닙니다.

## 이전 공개 자료

[2026-10-17 정상 저장 영수증 재사용 준비 소스](../public/legal/ygo-source-prepared-20261017-receipt-reuse-v12.tar.gz)와 [SHA-256](../public/legal/ygo-source-prepared-20261017-receipt-reuse-v12.sha256)을 제공합니다. 정상 영수증 재사용 기준 자료로 보존합니다.

[2026-10-17 전환 기록 처리·이력 정리 최적화 준비 소스](../public/legal/ygo-source-prepared-20261017-writer-processing-v11.tar.gz)와 [체크섬](../public/legal/ygo-source-prepared-20261017-writer-processing-v11.sha256)은 정상 저장 영수증 재사용 전 기준 자료로 보존합니다.

[2026-10-16 등록·제거 단계 계측 준비 소스](../public/legal/ygo-source-prepared-20261016-request-timing-v10.tar.gz)와 [체크섬](../public/legal/ygo-source-prepared-20261016-request-timing-v10.sha256)은 이번 최적화 전 기준 자료로 보존합니다.

[2026-10-16 보관·저장 왕복 축소 준비 소스](../public/legal/ygo-source-prepared-20261016-writer-latency-v9.tar.gz)와 [체크섬](../public/legal/ygo-source-prepared-20261016-writer-latency-v9.sha256)은 단계 계측 전 기준 자료로 보존합니다.

[2026-10-16 전환 기록·claims 처리 최적화 준비 소스](../public/legal/ygo-source-prepared-20261016-writer-hot-v8.tar.gz)와 [체크섬](../public/legal/ygo-source-prepared-20261016-writer-hot-v8.sha256)은 보관·저장 왕복 축소 전 기준 자료로 보존합니다.

[2026-10-16 사용자 조회 최적화 준비 소스](../public/legal/ygo-source-prepared-20261016-user-query-v7.tar.gz)와 [체크섬](../public/legal/ygo-source-prepared-20261016-user-query-v7.sha256)은 전환 기록·claims 최적화 전 자료로 보존합니다.

[2026-10-16 인벤토리 반복 조회 축소 준비 소스](../public/legal/ygo-source-prepared-20261016-inventory-latency-v6.tar.gz)와 [체크섬](../public/legal/ygo-source-prepared-20261016-inventory-latency-v6.sha256)은 사용자 조회 최적화 전 기준 자료로 보존합니다.

[2026-10-16 인증 진단 Hosting 준비 소스](../public/legal/ygo-source-prepared-20261016-auth-diagnostics-v5.tar.gz)와 [체크섬](../public/legal/ygo-source-prepared-20261016-auth-diagnostics-v5.sha256)은 프런트엔드 기준 자료로 보존합니다. 해당 묶음의 Functions·Job 소스는 v4와 같습니다.

[2026-10-16 CSV 이전 호환 수정 준비 소스](../public/legal/ygo-source-prepared-20261016-csv-legacy-v4.tar.gz)와 [체크섬](../public/legal/ygo-source-prepared-20261016-csv-legacy-v4.sha256)은 인벤토리 반복 조회 축소 전 Functions와 이번에 변경하지 않은 운영 Job 이미지의 준비 기준 자료로 보존합니다.

[2026-10-16 인벤토리 조회 수정 준비 소스](../public/legal/ygo-source-prepared-20261016-inventory-v3.tar.gz)와 [체크섬](../public/legal/ygo-source-prepared-20261016-inventory-v3.sha256)은 CSV 이전 호환 수정 전 자료로 보존합니다.

[2026-10-15 배포 준비 소스](../public/legal/ygo-source-prepared-20261015.tar.gz)와 [체크섬](../public/legal/ygo-source-prepared-20261015.sha256)도 보존합니다. 인벤토리 조회 수정 전 준비 자료이며 최신 준비본과 구분합니다.

[2026-09-08 운영 소스](../public/legal/ygo-source-20260908.tar.gz)와 [기존 체크섬](../public/legal/ygo-source-20260908.sha256)은 그대로 보존합니다. 이 자료는 당시 운영 소스이며 현재 준비본과 다릅니다. `FUNCTIONS.json`의 함수별 runtime·entryPoint·ZIP·원본/공개 해시 대응과 해당 묶음의 실행 안내를 따르십시오. 서로 다른 배포 ZIP을 한 버전으로 덮어 배포하지 않습니다.

## 라이선스와 제외 자료

운영자가 보유하거나 허락할 수 있는 자체 코드·문서는 [AGPL-3.0-only](../LICENSE)로 제공합니다. 제3자 라이브러리·모델에는 [각 원래 조건](THIRD_PARTY_NOTICES.md)이 적용됩니다. 게임 자산·브랜드·사용자 데이터는 [자산 고지](ASSET_RIGHTS.md)에서 구분합니다. 출처 표기나 소스 다운로드가 해당 자산의 이용허락을 추가로 부여하지 않습니다.

인증 비밀값·개인정보·운영 DB·개발 자료·비공개 문서는 포함하지 않습니다. 외부 CDN/API와 원문 미수집·플랫폼별 구성요소의 범위는 제3자 고지를 따릅니다.
