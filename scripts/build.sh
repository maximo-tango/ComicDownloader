#!/usr/bin/env bash
# Packages the extension as dist/image-hunter-<version>.zip.
# The archive holds one folder (manifest.json at its root) that Chrome can
# load directly via "압축해제된 확장 프로그램을 로드합니다".
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
name="image-hunter-${version}"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/$name"
cp -R extension/. "$stage/$name/"
cp docs/INSTALL.md "$stage/$name/설치 설명서.md"
[ -f docs/TEST_REPORT.md ] && cp docs/TEST_REPORT.md "$stage/$name/테스트 결과.md"

mkdir -p dist
rm -f "dist/${name}.zip"
(cd "$stage" && zip -qr -X "$OLDPWD/dist/${name}.zip" "$name")
echo "dist/${name}.zip ($(du -h "dist/${name}.zip" | cut -f1))"
