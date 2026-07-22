# tesla-kr-lineup

한국 테슬라 라인업 오버라이드 — Road to Tesla 앱이 부팅 시 fetch.

- `lineup_overrides.json` v1 스키마:
  - `version`: 호환성 flag
  - `add`: pricing API가 못 잡는 모델 (예: Cybertruck)
  - `hide`: API엔 있지만 국내 판매 중단된 모델 ID
  - `discontinuedNote`: hide된 모델에 표시할 문구
  - `lastVerified`: 사람이 마지막으로 확인한 날짜

앱은 fetch 실패 시 조용히 폴백 (bundled JSON만 사용).
