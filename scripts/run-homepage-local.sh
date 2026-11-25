#!/bin/zsh
# 맥 launchd 가 매일 실행. tesla.com 을 읽고, 확인된 변경은 main 에 push,
# 판단이 필요한 건 GitHub 이슈로 남긴다.
# 설치: scripts/install-launchd.sh
# 제거: launchctl bootout gui/$(id -u)/com.baekhg.tesla-kr-lineup
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export GIT_TERMINAL_PROMPT=0

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
echo "=== $(date '+%F %T') ==="

git checkout -q main
git pull -q --rebase
npm ci --no-audit --no-fund --silent

OUT="$(mktemp)"
GITHUB_OUTPUT="$OUT" node scripts/check-homepage.mjs > /dev/null
AUTO=$(grep '^auto_changed=' "$OUT" | cut -d= -f2)
REVIEW=$(grep '^needs_review=' "$OUT" | cut -d= -f2)
rm -f "$OUT"
REPORT=$(ls reports/homepage-*.json | sort | tail -1)
FINDINGS=$(node -e "const r=JSON.parse(require('fs').readFileSync('$REPORT','utf8'));console.log(r.findings.map(f=>'- '+f.detail).join('\n'))")

if [[ "$AUTO" == "true" ]]; then
  git add lineup_overrides.json "$REPORT"
  git commit -q -m "auto: tesla.com 기준 라인업 갱신"
  git push -q
  echo "pushed: $(git log --oneline -1)"
else
  # 날짜만 바뀐 override 와 리포트는 매일 노이즈라 버린다.
  git checkout -q -- lineup_overrides.json
  rm -f "$REPORT"
fi

if [[ "$REVIEW" == "true" ]]; then
  TITLE="[homepage] 라인업 확인 필요"
  NUM=$(gh issue list --state open --search "$TITLE in:title" --json number --jq '.[0].number')
  if [[ -n "$NUM" ]]; then
    gh issue comment "$NUM" --body "$(date +%F)
$FINDINGS" > /dev/null
  else
    gh issue create --title "$TITLE" --body "$FINDINGS" > /dev/null
  fi
  echo "review issue updated"
fi
echo "done auto=$AUTO review=$REVIEW"
