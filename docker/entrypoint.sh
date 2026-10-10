#!/bin/sh
set -eu
cd /app

if ! sha256sum --status -c /opt/dependency-locks.sha256; then
  echo '의존성 목록이 변경됐습니다. Docker 이미지를 다시 빌드한 뒤 컨테이너를 다시 생성하세요.' >&2
  exit 1
fi

case "${1:-dev}" in
  dev)
    node docker/prepare-dev.cjs
    set -- firebase emulators:start --config /app/firebase.docker.json \
      --project ygo-synapse --only hosting,functions,firestore,storage \
      --export-on-exit /data/emulators --non-interactive
    if [ -f /data/emulators/firebase-export-metadata.json ]; then
      set -- "$@" --import /data/emulators
    fi
    exec "$@"
    ;;
  test)
    # Git 제외 규칙 테스트용 빈 저장소. 호스트의 Git 이력·인증설정은 가져오지 않는다.
    git init --quiet /app
    exec node docker/run-tests.cjs
    ;;
  browser-test)
    exec node --test --test-concurrency=1 scripts/admin_notice_editor.browser.test.js scripts/admin_membership_csv.browser.test.js
    ;;
  *) exec "$@" ;;
esac
