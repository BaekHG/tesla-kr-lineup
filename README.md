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

## 봇 (`scripts/check-lineup.mjs`)

매일 Tesla 가격 API와 뉴스를 확인하고, 사람이 볼 변경이 있으면 `auto/lineup-refresh` PR을 연다.
조회 실패(429 등)는 PR 없이 workflow 경고로만 남긴다.
`TRIM_CODE_MAP`은 앱의 `price_sync_service.dart`와 같이 맞춘다.
