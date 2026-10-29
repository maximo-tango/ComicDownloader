# Image Hunter

웹페이지의 이미지를 **페이지에 나타난 순서 그대로** 추출해 하나의 연속 목록으로 보여주는 Chrome 확장 프로그램(Manifest V3)입니다. 원본 이미지 후보를 확인해서 일괄 다운로드하거나 PDF 한 파일로 저장합니다. 서버 없이 내 PC에서만 동작합니다.

- 지원 환경: Windows 11, Chrome 116 이상
- 설치: [docs/INSTALL.md](docs/INSTALL.md) · 테스트 결과: [docs/TEST_REPORT.md](docs/TEST_REPORT.md) · 변경 이력: [CHANGELOG.md](CHANGELOG.md)

## 주요 기능

| 기능 | 내용 |
| --- | --- |
| 이미지 추출 | `img.src`/`currentSrc`, `srcset`·`sizes`, `<picture>`, `data-src`·`data-srcset`·`data-original`, 이미지 URL이 들어 있는 다른 `data-*` 속성(검증 후 사용), 이미지 링크, CSS `background-image`(여러 개 포함), Shadow DOM, 스크롤하면 나타나는 이미지 |
| 순서 보존 | DOM 순서 그대로입니다. 재검색에서 새로 찾은 이미지는 페이지 안 실제 위치에 들어갑니다. 정렬 기능은 없고, 필터와 미리보기 크기는 순서를 바꾸지 않습니다. |
| 원본 후보 | 요소마다 후보 URL을 모으고 파일 앞부분을 읽어 실제 해상도·형식·크기를 확인합니다. 상태는 "원본 후보 확인 / 고해상도 후보 / 후보 비교 필요 / 확인 불가" 중 하나로 표시합니다. 카드에서 후보를 직접 바꿀 수 있습니다. |
| 연속 목록 | 단일 이미지 뷰어 없이 한 목록에서 봅니다. 미리보기는 작게·중간·크게 중에서 고르고, 방향키와 Space로 이동·선택합니다. |
| 필터 | 최소 너비·높이·파일 크기, 확장자, 원본 상태, 썸네일 의심 제외. 크기를 확인할 수 없는 항목을 표시할지 숨길지 정할 수 있습니다. |
| 다운로드 | 동시 다운로드 수 제한 대기열, 진행률, 성공·실패·취소 표시, 실패 항목만 재시도, 전체 취소, 결과 CSV/JSON 내보내기 |
| PDF | 선택해서 표시된 이미지를 순서대로 한 PDF에 넣습니다. 기본은 빈틈 없이 이어 붙이기(웹툰용)이고, JPEG은 그대로, 나머지는 무손실로 넣습니다. |
| 연속 PDF | 주소의 번호를 바꿔가며, 또는 회차 목록 페이지에서 비슷한 링크를 골라 여러 페이지를 차례로 열고, 스크롤·필터(기본 500×400 이상, JPG) 후 페이지마다 PDF 저장 |
| URL 직접 입력 | 여러 줄 붙여넣기, TXT/CSV 불러오기·내보내기, 입력 순서 유지, 중복 제거, 잘못된 URL 목록, 미리 확인 |

## 저장 위치와 파일명

파일은 **Chrome 다운로드 폴더 아래** 상대 경로에만 저장됩니다. 기본 다운로드 폴더는 보통 `C:\Users\<사용자>\Downloads`이며, 실제 위치는 Chrome 설정(설정 → 다운로드)에 따라 다릅니다.

```text
다운로드/
└── ImageHunter/
    ├── 페이지 제목/            ← 페이지 이미지 (설정에서 "사이트별" 또는 "없음"으로 바꿀 수 있음)
    │   ├── photo.jpg          ← 서버·URL이 알려준 파일명을 유지
    │   ├── photo (1).jpg      ← 다른 URL인데 이름이 같을 때
    │   ├── 페이지 제목_012.webp ← 파일명을 알 수 없을 때: 페이지 제목_순번
    │   └── 페이지 제목.pdf
    ├── 직접 입력/              ← URL 직접 입력 (하위 폴더 이름은 바꿀 수 있음)
    └── download_result_….csv
```

- Windows에서 쓸 수 없는 문자(`< > : " / \ | ? *`, 제어 문자, `CON`·`NUL` 등 예약어)는 `_`로 바꿉니다.
- 같은 이름의 파일이 이미 있으면 덮어쓰지 않습니다(기본값).
- 서버 응답이나 파일 내용으로 형식을 확인하지 못한 확장자는 다운로드 목록과 결과 파일에 **"확장자 추정"** 으로 표시합니다.

## 권한

| 권한 | 이유 |
| --- | --- |
| `activeTab` | 사이트 액세스를 제한했을 때, 메뉴를 연 탭의 페이지를 일시적으로 읽음 |
| `scripting` | 그 탭에서 이미지 수집 코드 실행 (페이지 DOM은 바꾸지 않음) |
| `downloads` | 다운로드와 파일명 지정 |
| `storage` | 설정, 다운로드 대기열 상태 저장 |
| `<all_urls>` (**기본 허용**, Chrome의 사이트 액세스에서 제한 가능) | 다른 사이트(CDN) 이미지의 파일 크기·형식 확인, 그 이미지들의 PDF 저장, 연속 PDF에서 페이지 자동 열기, 다른 사이트 iframe 추출 |

## 알려진 제한

- **인증·핫링크 방지·보안 정책을 우회하지 않습니다.** 사이트가 거부한 이미지는 "접근 거부 (403)" 같은 사유와 함께 실패로 표시합니다.
- 사이트 액세스를 제한해 권한이 없으면 다른 사이트 이미지의 **파일 크기**는 "확인 불가"로 표시됩니다(서버가 CORS를 허용하면 확인됨). 해상도는 이미지를 불러와서 확인합니다. 이런 이미지는 PDF에 넣지 못하고 사유와 함께 제외합니다.
- `blob:` URL 이미지는 그 페이지 안에서만 유효해서 다운로드할 수 없습니다. 목록에는 사유와 함께 표시합니다.
- 사이트 액세스를 제한하면 `activeTab` 권한만 쓰는데, 이 권한은 탭이 다른 페이지로 이동하면 사라집니다. 그 경우 해당 페이지에서 메뉴를 다시 열어야 합니다.
- iframe 안의 이미지는 본문 이미지 뒤에 이어서 표시합니다(iframe의 정확한 위치에 끼워 넣지는 않음).
- 자동 스크롤은 한 번에 설정한 화면 수(기본 30)까지만 합니다. 무한 스크롤 페이지는 버튼을 다시 누르면 이어서 확인합니다.
- PDF는 메모리에서 만듭니다. 수백 장의 고해상도 이미지는 시간과 메모리가 많이 듭니다.
- Chrome 내부 페이지(`chrome://`), 웹 스토어 등은 분석할 수 없습니다.

## 구조

지시서의 권장 구조와 실제 파일의 대응입니다.

```text
extension/                    ← Chrome에 로드하는 폴더
├── manifest.json
├── background.js             다운로드 대기열·상태·파일명 (download-manager 역할)
├── popup/                    popup.html·js — 실행 메뉴
├── options/                  options.html·js — 설정, 사이트 접근 권한
├── app/                      목록 화면 (viewer 역할; 단일 이미지 뷰어 아님)
│   ├── app.html·css·js       페이지 이미지 목록, 필터, 선택
│   ├── downloads-view.js     다운로드 현황, 결과 내보내기
│   ├── paste-view.js         URL 직접 입력
│   └── pdf-export.js         PDF 만들기
├── content/collector.js      페이지에 주입되는 추출기 (content.js + extractor.js)
└── lib/
    ├── resolver.js           원본 후보 판정 (image-candidates.js)
    ├── probe.js, image-header.js  이미지 메타데이터 확인 (image-metadata.js)
    ├── url-utils.js          URL 검증·정규화
    ├── ordering.js           순서 병합·중복 제거
    ├── filters.js, filename.js, export.js, pdf.js, paste.js, settings.js, variants.js
tests/                        자동 테스트, 테스트 사이트, 수동 테스트 절차 (tests/README.md)
scripts/                      build.sh (ZIP), make-icons.mjs
```

## 개발

```bash
npm install          # 테스트용 Puppeteer (확장 프로그램 자체는 외부 라이브러리 없음)
npm test             # 단위 + 브라우저 추출 테스트
npm run test:e2e     # 실제 Chrome에서 전체 기능
npm run build        # dist/image-hunter-<버전>.zip
```
