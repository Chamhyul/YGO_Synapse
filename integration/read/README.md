# 카드 읽기 통합 검사

기존 `YGO_Synapse` 저장소 루트와 그 안의 `card-service/`에서 두 검사 이미지를 만든다. 이미지에 포함된 소스만 사용하며 다른 저장소·준비본·호스트 자격증명·개발 데이터 볼륨을 연결하지 않는다. 독립 읽기 API는 보존된 선택 경로이고 RTDB 전환 구현이나 검증을 뜻하지 않는다.

```sh
# 모두 기존 저장소 루트에서 실행
docker build -t ygo-synapse:local .
docker build -t ygo-card-service:local card-service
docker compose -f integration/read/compose.yaml up --abort-on-container-exit --exit-code-from tests
# 성공/실패 후 이 검사 구성만 정리. 볼륨 삭제 옵션을 사용하지 않는다.
docker compose -f integration/read/compose.yaml down
```

기존 실행 중인 개발 서버는 유지한다. 다른 이미지 버전은 `MAIN_IMAGE`·`CARD_IMAGE`의 로컬 태그 또는 고정 digest로 지정한다. `compose.read-test.yaml`도 위 구성만 포함하는 호환 진입점이다. 원격 저장소 최신 브랜치를 자동 다운로드하지 않으며 검사 결과에는 사용 이미지와 카드 패키지 release를 함께 남긴다.

전용 internal 네트워크 안에서 Firestore·Storage 에뮬레이터, 두 서비스, 연결 거부 대상 main, 검사기를 실행한다. 외부 통신·공개 포트·호스트 자격증명·개발 데이터 볼륨을 사용하지 않는다. 합성 demo 프로젝트와 데이터만 생성하고 기존 dev에 접속하지 않는다. 에뮬레이터 데이터는 이 컨테이너 실행 동안만 유지한다.

검사 대상은 공개 카드·초기 metadata·배치 metadata·이름/번호 해석·getCardInfo의 키/CORS/쿼터·인벤토리 등록에서의 카드 조회와 실패 시 저장물 보존이다. DB/Storage는 실제 Admin SDK와 에뮬레이터를 사용한다. 앱/사용자/서비스 인증은 전용 검사 진입점에서 합성한다. 실제 Google OIDC·IAM·운영 데이터 접근·실계정 검증을 대신하지 않는다.

Firebase의 [Firestore 에뮬레이터 연결](https://firebase.google.com/docs/emulator-suite/connect_firestore)과 [Storage 에뮬레이터 연결](https://firebase.google.com/docs/emulator-suite/connect_storage)의 환경변수를 사용한다. 일반 서버는 합성 인증 함수를 가져오지 않는다.

이 검사는 기존 읽기 경계를 확인하기 위해 두 demo 프로젝트 이름을 사용한다. 같은 운영 Firebase 프로젝트의 RTDB 사용자 저장소·권한·이전 정합성 검증은 별도 구현 대상이며 현재 결과로 대체하지 않는다.
