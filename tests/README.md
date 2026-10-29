# Image Hunter 테스트

## 자동 테스트

```bash
npm install            # Puppeteer + Chrome for Testing (브라우저 테스트용)
npm test               # 단위 테스트 + 브라우저 추출 테스트 (Chrome이 없으면 브라우저 테스트는 건너뜀)
npm run test:e2e       # 확장 프로그램 전체를 실제 Chrome에서 실행하는 종단 간 테스트
```

| 파일 | 내용 | 실행 환경 |
| --- | --- | --- |
| `url-utils.test.js` | 절대경로 변환, URL 종류 구분(http·data·blob·javascript·잘못된 URL), 보수적 중복 키 | Node |
| `ordering.test.js` | 재검색 순서 병합, 첫 항목 기준 중복 제거, 지시서의 A·B·C 시나리오 | Node |
| `resolver.test.js` | 원본 후보 판정, 원본 상태 4가지, 후보 직접 선택, URL 추측 기본 꺼짐 | Node |
| `variants.test.js` | (선택 옵션) URL 패턴 추측 규칙 | Node |
| `image-header.test.js` | 파일 앞부분으로 형식·해상도 확인 (JPEG EXIF 회전, AVIF, SVG 등) | Node |
| `filename.test.js` | Windows 금지 문자, `이름 (1)` 충돌 처리, `페이지제목_순번`, 확장자 추정 표시, 폴더 | Node |
| `filters.test.js` | 필터가 순서·데이터를 바꾸지 않음, 입력값 검사 | Node |
| `paste-probe.test.js` | URL 목록 입력 검사, Range 요청으로 크기 확인 | Node |
| `export-pdf.test.js` | CSV(수식 삽입 방지)·JSON 내보내기, PDF 구조(xref, JPEG 그대로 넣기, 무손실) | Node |
| `extractor.test.js` | 실제 Chrome 페이지에서 수집기 실행: DOM 순서, srcset·sizes·data-*, 잘못된 URL, 페이지 DOM 무변경, Shadow DOM, 자동 스크롤 제한 | Chrome (headless) |
| `e2e/e2e.mjs` | 확장 프로그램 전체: 목록 UI, 필터, 선택, 재검색, PDF, 다운로드·재시도·취소, 내보내기, URL 입력, 탭 이동, 서비스 워커 재시작, 1000장 성능 | Chrome (headless) |

E2E는 Puppeteer가 툴바 버튼을 누를 수 없어서 `activeTab` 권한 부여를 재현할 수 없습니다. 그래서 테스트용 사본의 manifest에만 `http://127.0.0.1/*` 권한을 추가합니다. 이 권한은 그 페이지에서 메뉴를 열었을 때 activeTab이 주는 접근 범위와 같습니다. 두 번째 출처(`http://localhost`)는 권한 없이 두어, 권한이 없을 때의 동작(크기 "확인 불가", PDF 제외)도 확인합니다.

## 수동 테스트 (실제 Chrome / Windows 11)

자동화할 수 없는 항목입니다. 로컬 테스트 사이트를 띄워서 확인합니다.

```bash
node tests/fixtures/server.mjs     # http://localhost:8765/  (/order, /many?n=1000 도 있음)
```

| # | 절차 | 기대 결과 |
| --- | --- | --- |
| M1 | `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램을 로드합니다** → `extension` 폴더 | 오류 없이 로드되고 "오류" 버튼이 나타나지 않음 |
| M2 | 테스트 사이트에서 툴바 아이콘 클릭(또는 Alt+Shift+I) → **이 페이지의 이미지 찾기** | 새 탭에서 목록이 열리고 이미지가 페이지 순서대로 표시됨 (activeTab만으로 동작) |
| M3 | `chrome://extensions` 페이지에서 메뉴를 열기 | "이 페이지의 이미지 찾기"가 꺼져 있고 안내 문구가 나타남 |
| M4 | 분석 중인 탭에서 다른 사이트로 이동한 뒤 **다시 검색** | "이 탭에 접근할 수 없습니다 …" 안내가 나오고, 이전 목록은 그대로 남음 |
| M5 | 설정 → **모든 사이트 접근 허용** | Chrome 권한 확인 창이 뜸. 허용 후 다른 사이트 이미지의 파일 크기가 표시되고 PDF에도 들어감. **권한 해제** 후 원래대로 돌아감 |
| M6 | Windows 11에서 제목에 `: ? * " < > |` 가 들어간 페이지의 이미지를 다운로드 | `다운로드\ImageHunter\<'_'로 바뀐 제목>\` 폴더에 저장됨 |
| M7 | 같은 이미지를 다른 탭에서 두 번 내려받기 | 두 번째 파일이 `이름 (1).png`로 저장되고 덮어쓰지 않음 |
| M8 | Chrome 설정 → 다운로드 → "다운로드 전에 각 파일의 저장 위치 확인" 켜기 → 다운로드 | Chrome 저장 창이 뜨고, 기본 이름이 Image Hunter가 정한 이름임 |
| M9 | 다운로드 도중 `chrome://serviceworker-internals`에서 Image Hunter **Stop** | 다운로드 탭 진행률이 잠시 멈췄다가 다시 갱신되고 완료로 바뀜 |
| M10 | 실제 무한 스크롤 사이트에서 **스크롤하며 추가 검색** 여러 번 | 한 번에 설정한 화면 수(기본 30)까지만 스크롤하고 원래 위치로 돌아감. 새 이미지는 페이지 위치에 들어감 |
| M11 | 큰 웹툰(세로로 긴 이미지 50장 이상) → 전체 선택 → **PDF로 저장** | PDF 뷰어에서 순서대로 열림. 14400pt보다 긴 이미지는 비율을 유지한 채 축소됨 |
| M12 | 다크 모드(Windows 설정)에서 목록·설정·팝업 확인 | 글자와 배경 대비가 충분함 |
