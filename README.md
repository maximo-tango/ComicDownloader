# Image Hunter

웹페이지에서 썸네일이 아닌 **원본 이미지**를 찾아 순차 탐색하고 일괄 다운로드하는 Chrome 확장 프로그램입니다 (Manifest V3, 서버 불필요).

- 원본 판별: srcset, 링크, 고해상도 속성, 썸네일 규칙을 되돌린 변형 URL을 모은 뒤 **실제 해상도를 확인**해서 고름. 출처와 신뢰도도 기록
- 순차 뷰어: 파일명이 아니라 목록 순서로 이전·다음 이동, 키보드 조작
- 필터·정렬·선택, 사이트별 폴더 저장, 파일명 충돌 방지, 진행률·실패 사유·재시도
- URL 목록 붙여넣기 일괄 다운로드

## 구조

```
extension/            확장 프로그램 (Chrome에 로드할 폴더)
  manifest.json
  background.js       다운로드 대기열, 파일명 결정, Referer 규칙
  content/collector.js  페이지에 주입되는 이미지 수집·자동 스크롤
  lib/                resolver(원본 판별), probe(헤더로 해상도·크기 확인), variants, image-header,
                      filename, filters, paste, settings
  app/                분석·뷰어·다운로드·붙여넣기 화면
tests/                단위 테스트, E2E(Puppeteer), 테스트 사이트(fixtures)
docs/                 설치 설명서, 테스트 결과
scripts/              build.sh(ZIP 패키지), make-icons.mjs
```

## 개발

```bash
npm install
npm test              # 단위 테스트
npm run test:e2e      # 실제 Chrome으로 E2E
npm run build         # dist/image-hunter-<버전>.zip
```

설치와 사용법은 [docs/INSTALL.md](docs/INSTALL.md), 테스트 결과는 [docs/TEST_REPORT.md](docs/TEST_REPORT.md)를 참고하세요.
