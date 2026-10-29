#!/usr/bin/env bash
# Packages the extension as dist/image-hunter-<version>.zip.
# Layout:  image-hunter-<version>/manifest.json …  ← load this folder in Chrome
#          image-hunter-<version>/docs/             ← install guide, test report, README
# (manifest.json must be at the top: Chrome reports "매니페스트 파일이 없거나
#  읽을 수 없습니다" when the selected folder only contains a subfolder.)
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
name="image-hunter-${version}"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/$name"
cp -R extension/. "$stage/$name/"
mkdir -p "$stage/$name/docs"
cp docs/INSTALL.md "$stage/$name/docs/설치 설명서.md"
cp docs/TEST_REPORT.md "$stage/$name/docs/테스트 결과.md"
cp README.md CHANGELOG.md "$stage/$name/docs/"

mkdir -p dist
rm -f "dist/${name}.zip"
(cd "$stage" && zip -qr -X "$OLDPWD/dist/${name}.zip" "$name")
echo "dist/${name}.zip ($(du -h "dist/${name}.zip" | cut -f1))"
