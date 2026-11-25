# tesla-kr-lineup

한국 테슬라 라인업 오버라이드 — Road to Tesla 앱이 부팅 시 fetch.

- `lineup_overrides.json` v1 스키마:
  - `version`: 호환성 flag
  - `add`: pricing API가 못 잡는 모델 (예: Cybertruck)
  - `hide`: API엔 있지만 국내 판매 중단된 모델 ID
  - `discontinuedNote`: hide된 모델에 표시할 문구
  - `hideTrims`: 주문이 막힌 트림 ID (모델은 계속 판매)
  - `trimNotes`: 트림에 붙일 안내 문구
  - `modelNotices`: 판매는 계속되지만 알려야 할 소식 (예: 생산 종료 예정)
  - `lastVerified`: 사람이 마지막으로 확인한 날짜

새 필드는 모두 선택 항목이라 옛 앱 버전은 무시하고 지나간다.

앱은 fetch 실패 시 조용히 폴백 (bundled JSON만 사용).

## 홈페이지 확인 (`scripts/check-homepage.mjs`, 맥에서 실행)

tesla.com/ko_kr 주문 페이지를 실제 Chrome 으로 열어 트림 이름·가격·선택 가능 여부를 읽는다.
가격 API 에 없는 사이버트럭도 여기서 잡힌다.

- override 가 들고 있는 트림 가격, 주문 막힘/다시 열림 → 확인되면 바로 main 에 push
- 처음 보는 트림, 페이지 못 읽음, 단종 모델 주문 재개, API 와 가격 불일치 → `[homepage] 라인업 확인 필요` 이슈

tesla.com 이 headless 브라우저와 데이터센터 IP(GitHub Actions 포함)를 막아서 GitHub Actions 가 아니라
가정용 회선의 맥에서 launchd 로 매일 07:00 에 돈다.

```sh
scripts/install-launchd.sh                                   # 설치
launchctl bootout gui/$(id -u)/com.baekhg.tesla-kr-lineup    # 제거
tail -f ~/Library/Logs/tesla-kr-lineup.log                   # 로그
```

## 봇 (`scripts/check-lineup.mjs`)

매일 Tesla 가격 API와 뉴스를 확인하고, 사람이 볼 변경이 있으면 `auto/lineup-refresh` PR을 연다.
조회 실패(429 등)는 PR 없이 workflow 경고로만 남긴다.
`TRIM_CODE_MAP`은 앱의 `price_sync_service.dart`와 같이 맞춘다.

## 보조금 현황 (`subsidy_status.json`)

`scripts/check-subsidy.mjs` 가 ev.or.kr "구매보조금 지급 현황" 에서 지역별 전기승용
공고·접수·선정·출고·잔여 대수를 읽는다. 하루 두 번 Actions(`subsidy-check.yml`)로,
그리고 맥 launchd 작업(`run-homepage-local.sh`) 끝에 한 번 더 돈다.
공공 데이터 사본이라 변경이 있으면 리뷰 없이 main 에 바로 커밋한다.
일부 지역만 읽히면 파일을 덮어쓰지 않는다.

## 테슬라 운반선 (`vessels.json`)

`scripts/check-vessels.mjs` 가 관세청 UNI-PASS 화물통관진행정보(API001)로 평택항 테슬라 운반선을
찾는다. 글로비스 평택 수입 MRN(`26GLVSP###I`)이 순서대로 붙는 걸 이용해 마지막 번호 뒤를 훑고,
상하이 선적 `(TESLA) MOTOR VEHICLES` 묶음만 합친다. 차종은 세관 신고 1대당 무게로 나눈다.
3시간마다 Actions(`vessels-check.yml`, secret `CUSTOMS_KEY_CARGO`) + 맥 launchd 에서 돈다.

## Oracle 서버

`scripts/run-server.sh vessels|subsidy` 를 Oracle A1(arm64) cron 이 돌린다. 매번 origin/main 으로
맞추고(스크립트 수정 자동 반영) Playwright 공식 Docker 이미지에서 CPU 1개·메모리 2GB 로 실행한다.
키는 서버의 `~/.tesla-kr-lineup.env`, push 는 쓰기 권한 deploy key(`oracle-a1 bot`).
Actions 는 서버가 멈췄을 때를 위한 예비로 계속 돈다. tesla.com 확인은 데이터센터 IP 가 막혀서 맥에서만.
