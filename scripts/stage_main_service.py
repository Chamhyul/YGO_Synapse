"""현재 기존 서비스 소스를 별도 저장소 준비 폴더에 보관한다. 운영/네트워크 접근 없음."""
from pathlib import Path
import argparse
import hashlib
import json

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "main-service"
DIRECTORIES = ("public", "functions", "scripts", "docker", "legal", ".github/workflows")
ROOT_FILES = ("AGENTS.md", "README.md", "LICENSE", "package.json", "package-lock.json",
              "firebase.json", "firebase.test.json", ".firebaserc", "firestore.rules",
              "firestore.indexes.json", "storage.rules", "Dockerfile", "compose.yaml",
              ".gitignore", ".dockerignore")


def allowed(path):
    if path.is_symlink():
        return False
    if any(part in {"node_modules", ".git", ".firebase", "private", "docs", "previews"}
           for part in path.parts):
        return False
    name = path.name.lower()
    return not (name.startswith((".env", ".secret", "gha-creds-"))
                or (path.suffix.lower() == ".json" and ("serviceaccount" in name or "service-account" in name))
                or name == ".runtimeconfig.json"
                or path.suffix.lower() in {".pem", ".p12", ".log", ".zip"}
                or name == ".ds_store")


def content(path):
    data = path.read_bytes()
    if path == ROOT / ".dockerignore":
        additions = b"!operations/\n!operations/workflows/\n!operations/workflows/*.disabled\n!integration/\n!integration/read/\n!integration/read/*\n!LICENSE\n!legal/\n!legal/**\n!card-service.lock.json\n\n"
        # 공개 소스 허용 뒤에도 자격증명·private/docs의 기존 후순위 제외가 최종 적용된다.
        data = data.replace(b"**/node_modules\n", additions + b"**/node_modules\n", 1)
    if path in [ROOT / "AGENTS.md", ROOT / "README.md"]:
        data = (ROOT / "repository-templates/main" / path.name).read_bytes()
    if path == ROOT / "functions/package.json":
        package = json.loads(data)
        package["dependencies"]["express"] = "5.2.1"
        package["scripts"]["start:server"] = "node server.js"
        data = (json.dumps(package, ensure_ascii=False, indent=2) + "\n").encode()
    if path == ROOT / "functions/package-lock.json":
        package = json.loads(data)
        package["packages"][""]["dependencies"]["express"] = "5.2.1"
        data = (json.dumps(package, ensure_ascii=False, indent=2) + "\n").encode()
    if path == ROOT / "compose.yaml":
        # 별도 폴더의 빌드·검사가 상위 작업 폴더를 필요로 하지 않도록 구성한다.
        data = data.replace(b"name: ygo-synapse", b"name: ygo-main-service", 1)
        data = data.replace(b"ygo-synapse-local:dev", b"ygo-main-service:local")
        data = data.replace(b"    - ./card-service:/app/card-service:ro\n", b"")
        data = data.replace(b"./previews/document-specimen.html", b"./scripts/fixtures/document-specimen.html")
        data = data.replace("문서 UI 테스트가 읽는 합성 견본 하나만 연결한다. 이미지에는 포함하지 않는다.".encode(),
                            "자체 합성 견본을 기존 검사 경로에도 연결한다. 이미지에는 scripts/fixtures로 포함한다.".encode())
        for port in range(5001, 5006):
            data = data.replace(f"127.0.0.1:{port}:".encode(), f"127.0.0.1:{port+100}:".encode())
        data = data.replace(b"127.0.0.1:9150:", b"127.0.0.1:9250:")
        data = data.replace(b"services:\n", b"""services:
  read-api:
    image: ygo-main-service:local
    build: .
    command: [node, functions/server.js]
    profiles: [read-api]
    environment:
      GCLOUD_PROJECT: ${MAIN_PROJECT_ID:-}
      STORAGE_BUCKET: ${MAIN_STORAGE_BUCKET:-}
      CARD_SERVICE_URL: ${CARD_SERVICE_URL:-}
      CARD_SERVICE_AUDIENCE: ${CARD_SERVICE_AUDIENCE:-}
    ports: ["127.0.0.1:5090:8080"]
    restart: "no"
""", 1)
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="원본 대조 후 준비 폴더 갱신")
    args = parser.parse_args()
    sources = [ROOT / file for file in ROOT_FILES if (ROOT / file).is_file()]
    for directory in DIRECTORIES:
        sources.extend(path for path in (ROOT / directory).rglob("*") if path.is_file() and allowed(path))
    expected = {str(path.relative_to(ROOT)): content(path) for path in sorted(sources)
                if path.name not in {"stage_main_service.py", "sync-card-service.cjs"}}
    modes = {str(path.relative_to(ROOT)): path.stat().st_mode & 0o777 for path in sources}
    expected["card-service.lock.json"] = (ROOT / "functions/services/card-service/release.json").read_bytes()
    # 원본 작업 트리의 운영 워크플로는 보존하고 게시 준비본에서만 비활성 참고본으로 옮긴다.
    for file in list(expected):
        if file.startswith(".github/workflows/"):
            expected["operations/workflows/" + Path(file).name + ".disabled"] = expected.pop(file)
    for directory, prefix in [(ROOT / "repository-templates/main", ""), (ROOT / "integration/read", "integration/read/")]:
        for path in directory.rglob("*"):
            if path.is_file() and (allowed(path) or path.name == ".env.example"):
                file = prefix + str(path.relative_to(directory))
                expected[file] = path.read_bytes()
                modes[file] = path.stat().st_mode & 0o777
    old_manifest = TARGET / "source-manifest.json"
    previous = json.loads(old_manifest.read_text()) if old_manifest.exists() else {"sha256": {}}
    existing = {str(path.relative_to(TARGET)) for path in TARGET.rglob("*") if path.is_file()}
    unknown = existing - set(previous["sha256"]) - {"source-manifest.json"}
    if unknown:
        raise SystemExit("준비 폴더의 미등록 파일을 보존합니다: " + ", ".join(sorted(unknown)))
    # 준비 폴더를 직접 수정한 내용은 자동 덮어쓰지 않는다.
    for file, digest in previous["sha256"].items():
        destination = TARGET / file
        if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
            raise SystemExit("준비 폴더의 직접 변경을 보존합니다: " + file)
    differences = [file for file, data in expected.items()
                   if not (TARGET / file).is_file() or (TARGET / file).read_bytes() != data]
    stale = set(previous["sha256"]) - set(expected)
    if args.write:
        for file, data in expected.items():
            destination = TARGET / file
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            destination.chmod(modes.get(file, 0o644))
        for file in stale:
            (TARGET / file).unlink(missing_ok=True)
        manifest = {"format": 1, "role": "기존 서비스의 별도 GitHub 저장소 준비본",
                    "transforms": {"compose.yaml": "독립 이미지·프로젝트·포트와 자체 합성 견본 사용",
                                   "functions/package.json": "독립 HTTP 서버 명령과 기존 Express 버전 직접 의존성",
                                   "functions/package-lock.json": "기존 Express5.2.1의 루트 의존성 명시"},
                    "publication": {"activeWorkflows": ["ci.yml"], "operations": "비활성 참고본",
                                    "templates": "repository-templates/main", "integration": "integration/read"},
                    "sha256": {file: hashlib.sha256(data).hexdigest() for file, data in expected.items()}}
        old_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    elif differences or stale:
        raise SystemExit("원본/준비 폴더 불일치: " + ", ".join(sorted(set(differences) | stale)))
    print(f"기존 서비스 {len(expected)}개 파일: {'보관' if args.write else '대조'} 완료")


if __name__ == "__main__":
    main()
