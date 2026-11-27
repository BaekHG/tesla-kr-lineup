#!/usr/bin/env bash
# Oracle 서버(arm64) cron 진입점. 사용: run-server.sh vessels|subsidy|fsd|tesla
#
# - flock: 같은 작업이 겹쳐 돌지 않게.
# - 매번 origin/main 으로 맞춘다 → 스크립트를 고치면 다음 실행부터 자동 반영.
# - Docker(Playwright 공식 이미지)에서 CPU 1개·메모리 2GB 로 제한 → 같은 서버의 다른 서비스 보호.
# - 실패해도 기존 JSON 은 안 건드리고, push 충돌이면 버리고 다음 회차에 다시.
# 키: ~/.tesla-kr-lineup.env (CUSTOMS_KEY_CARGO, DATA_GO_KR_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY)
set -euo pipefail

JOB="${1:?vessels|subsidy|fsd|tesla}"
case "$JOB" in
  vessels) SCRIPT=scripts/check-vessels.mjs; OUT=vessels.json; MSG="auto: 테슬라 운반선 현황 갱신" ;;
  subsidy) SCRIPT=scripts/check-subsidy.mjs; OUT=subsidy_status.json; MSG="auto: 보조금 현황 갱신" ;;
  # FSD 소식은 Supabase 에 바로 넣는다 → git 커밋 없음.
  fsd) SCRIPT=scripts/check-fsd.mjs; OUT=""; MSG="" ;;
  # 테슬라 계정 연결 사용자 동기화 → Supabase 직접. 키(TESLA_CLIENT_ID) 없으면 바로 끝남.
  tesla) SCRIPT=scripts/tesla-sync.mjs; OUT=""; MSG="" ;;
  *) echo "unknown job: $JOB" >&2; exit 2 ;;
esac

REPO="$HOME/tesla-kr-lineup"
ENV_FILE="$HOME/.tesla-kr-lineup.env"
IMAGE="mcr.microsoft.com/playwright:v1.65.1-jammy"
LOCK="/tmp/tesla-kr-lineup-$JOB.lock"

exec 9>"$LOCK"
flock -n 9 || { echo "$(date '+%F %T') $JOB: 이전 실행이 아직 도는 중 — 건너뜀"; exit 0; }

cd "$REPO"
echo "=== $(date '+%F %T') $JOB"

git fetch -q origin main
git reset -q --hard origin/main

TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_OUT"' EXIT

# node_modules 는 컨테이너 안 캐시 볼륨에 두고 package-lock 이 바뀔 때만 다시 설치.
if timeout 25m docker run --rm \
    --cpus=1 --memory=2g --init \
    --env-file "$ENV_FILE" \
    -e GITHUB_OUTPUT=/out/github_output \
    -v "$REPO":/work -v tesla-kr-lineup-nm:/work/node_modules \
    -v "$TMP_OUT":/out/github_output \
    -w /work "$IMAGE" \
    bash -c 'cmp -s package-lock.json node_modules/.lock-copy 2>/dev/null || { npm ci --no-audit --no-fund --silent && cp package-lock.json node_modules/.lock-copy; }; node '"$SCRIPT"; then
  :
else
  echo "$JOB: 수집 실패 (exit $?) — 기존 데이터 유지"
  [[ -n "$OUT" ]] && git checkout -q -- "$OUT" 2>/dev/null || true
  exit 1
fi

[[ -z "$OUT" ]] && exit 0

# 컨테이너는 root 로 쓰므로 소유권을 되돌린다.
sudo chown -R "$(id -u):$(id -g)" "$REPO" 2>/dev/null || true

if grep -q '^has_changes=true' "$TMP_OUT"; then
  git add "$OUT"
  git commit -q -m "$MSG (oracle)"
  for attempt in 1 2 3; do
    if git pull -q --rebase origin main && git push -q origin HEAD:main; then
      echo "$JOB: pushed $(git log --oneline -1)"
      exit 0
    fi
    git rebase --abort 2>/dev/null || true
    sleep $((attempt * 5))
  done
  # 다른 실행(Actions 등)과 같은 파일을 동시에 고친 경우 — 버리고 다음 회차에 최신으로 다시.
  echo "$JOB: push 충돌 — 이번 결과 버림"
  git reset -q --hard origin/main
else
  echo "$JOB: 변경 없음"
fi
