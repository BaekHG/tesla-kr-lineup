#!/usr/bin/env node
/*
 * check-lineup.mjs
 *
 * 매일 GitHub Actions cron으로 실행.
 * 데이터 소스:
 *   1. Tesla KR pricing API   (모델/트림 존재 + 가격 감지)
 *   2. Google News RSS        (한국어 단종/출시 뉴스 시그널)
 *
 * 현재 lineup_overrides.json과 diff → 변경 필요 시 파일 수정 + PR 생성.
 * 위험한 자동 결정은 피하고 사람 눈으로 30초 리뷰하도록 PR로 유도한다.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OVERRIDE_PATH = path.join(REPO_ROOT, 'lineup_overrides.json');
const REPORT_PATH = path.join(REPO_ROOT, 'reports', `run-${dateOnly(new Date())}.md`);

const TESLA_API = 'https://apigateway-pricing-gateway.tesla.com/pricing/v2/KR?region=KR';
const NEWS_RSS = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;

// Tesla API `trim_code` → 우리 로컬 trim.id (앱과 동기 유지)
const TRIM_CODE_MAP = {
  $MT367: 'model3_rwd',
  $MT369: 'model3_lr_rwd',
  $MT371: 'model3_perf',
  $MTY56: 'modely_rwd',
  $MTY64: 'modely_lr_awd',
  $MTY74: 'modely_l',
  $MTS22: 'models_lr',
  $MTS23: 'models_plaid',
  $MTX22: 'modelx_lr',
  $MTX23: 'modelx_plaid',
};

const MODEL_CODE_TO_ID = {
  m3: 'model3',
  my: 'modely',
  ms: 'models',
  mx: 'modelx',
  ct: 'cybertruck',
};

// Google News 검색 쿼리 → 시그널
const SIGNALS = [
  {
    kind: 'discontinuation',
    queries: ['테슬라 모델S 국내 판매 중단', '테슬라 모델X 단종', '사이버트럭 단종'],
    keywords: ['단종', '판매 중단', '판매 종료', '중단', '종료'],
  },
  {
    kind: 'launch',
    queries: ['테슬라 신모델 국내 출시', '테슬라 국내 인도 시작'],
    keywords: ['출시', '인도', '상륙', '판매 시작'],
  },
];

async function main() {
  const override = JSON.parse(await fs.readFile(OVERRIDE_PATH, 'utf8'));
  const findings = [];

  // 1. Tesla API 스냅샷
  const api = await fetchJson(TESLA_API);
  const apiSnapshot = parseApi(api);
  findings.push(...diffApiVsOverride(apiSnapshot, override));

  // 2. 뉴스 시그널
  for (const sig of SIGNALS) {
    for (const q of sig.queries) {
      try {
        const items = await fetchNews(q, sig.keywords, 7);
        for (const it of items) findings.push({ kind: sig.kind, ...it });
      } catch (e) {
        findings.push({
          kind: 'error',
          query: q,
          detail: `RSS fetch 실패: ${e.message}`,
        });
      }
    }
  }

  // 3. 리포트 저장
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, renderReport(apiSnapshot, findings), 'utf8');

  // 4. override 자동 수정 (안전한 것만)
  const { changed, notes } = applySafeAutoEdits(override, apiSnapshot);
  if (changed) {
    override.lastVerified = dateOnly(new Date());
    await fs.writeFile(OVERRIDE_PATH, JSON.stringify(override, null, 2) + '\n');
    console.log('lineup_overrides.json 자동 업데이트됨:');
    for (const n of notes) console.log(' -', n);
  } else {
    console.log('자동 수정 없음. reports/에 findings 저장됨.');
  }

  // 5. GitHub Actions output (workflow가 PR 여부 결정)
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    await fs.appendFile(summary, renderReport(apiSnapshot, findings));
  }
  const gitOutput = process.env.GITHUB_OUTPUT;
  if (gitOutput) {
    const shouldPr = changed || findings.some((f) => f.kind !== 'ok');
    await fs.appendFile(gitOutput, `has_changes=${shouldPr}\n`);
  }
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'tesla-kr-lineup-bot/1' },
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { Accept: 'application/rss+xml, text/xml', 'User-Agent': 'tesla-kr-lineup-bot/1' },
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.text();
}

function parseApi(raw) {
  const kr = raw?.KR ?? {};
  const models = {};
  for (const [modelCode, trims] of Object.entries(kr)) {
    const modelId = MODEL_CODE_TO_ID[modelCode];
    if (!modelId || !Array.isArray(trims)) continue;
    models[modelId] = trims
      .map((t) => ({
        trim_code: t.trim_code,
        local_id: TRIM_CODE_MAP[t.trim_code] ?? null,
        variant: t.variant,
        trim_name: t.trim_name,
        price: t?.cash?.price ?? null,
      }))
      .filter((t) => t.trim_code);
  }
  return { models };
}

function diffApiVsOverride(api, override) {
  const findings = [];
  const knownIds = new Set(Object.values(TRIM_CODE_MAP));

  for (const [modelId, trims] of Object.entries(api.models)) {
    for (const t of trims) {
      if (!t.local_id) {
        findings.push({
          kind: 'unknown_trim',
          detail: `API에 새 트림 등장 → 앱 TRIM_CODE_MAP 업데이트 필요: ${modelId} / ${t.trim_code} / ${t.variant}`,
        });
      }
    }
    if (override.hide.includes(modelId) && trims.length > 0) {
      // API엔 계속 있는데 우리가 hide 처리 중 — 정상 (단종된 모델의 재고 밀어내기 등)
      findings.push({
        kind: 'ok',
        detail: `${modelId}: API에 여전히 있지만 hide 유지 중`,
      });
    }
  }

  // 로컬 trim id 중에 API가 안 주는 것 감지 (트림 사라짐)
  const apiLocalIds = new Set(
    Object.values(api.models).flatMap((ts) => ts.map((t) => t.local_id).filter(Boolean)),
  );
  for (const id of knownIds) {
    if (!apiLocalIds.has(id)) {
      findings.push({
        kind: 'trim_missing_from_api',
        detail: `트림 ${id}가 API 응답에서 사라짐 (단종 signal?)`,
      });
    }
  }

  return findings;
}

async function fetchNews(query, keywords, sinceDays) {
  const xml = await fetchText(NEWS_RSS(query));
  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(xml);
  const rawItems = doc?.rss?.channel?.item ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const cutoff = Date.now() - sinceDays * 86400_000;
  const results = [];
  for (const it of items) {
    const title = (it.title ?? '').toString();
    const pub = new Date(it.pubDate ?? 0).getTime();
    if (!pub || pub < cutoff) continue;
    const hit = keywords.find((k) => title.includes(k));
    if (!hit) continue;
    results.push({
      title: title.slice(0, 120),
      source: (it.source?.['#text'] ?? it.source ?? '').toString(),
      pub: new Date(pub).toISOString(),
      link: it.link,
      matched: hit,
      query,
    });
  }
  return results;
}

/**
 * 사람 리뷰 없이 자동 반영해도 안전한 변경만 수행.
 * 현재 정책: **아무것도 자동 반영하지 않는다**. Findings만 리포트에 남긴다.
 * 나중에 확신이 서면 add/hide 자동 반영 로직을 여기 추가.
 */
function applySafeAutoEdits(_override, _api) {
  return { changed: false, notes: [] };
}

function renderReport(api, findings) {
  const lines = [];
  lines.push(`# Lineup check — ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Tesla API 스냅샷');
  for (const [modelId, trims] of Object.entries(api.models)) {
    lines.push(`- **${modelId}** (${trims.length} trims)`);
    for (const t of trims) {
      const price = t.price ? `${(t.price / 10_000).toFixed(0)}만원` : '?';
      lines.push(`  - \`${t.trim_code}\` → \`${t.local_id ?? '???'}\` (${t.trim_name ?? t.variant}) — ${price}`);
    }
  }
  lines.push('');
  lines.push('## Findings');
  if (findings.length === 0) {
    lines.push('_변경 신호 없음_');
  } else {
    for (const f of findings) {
      if (f.kind === 'ok') continue;
      lines.push(`- **[${f.kind}]** ${f.detail ?? f.title ?? ''}`);
      if (f.source) lines.push(`  - 출처: ${f.source} · ${f.pub}`);
      if (f.link) lines.push(`  - ${f.link}`);
    }
  }
  return lines.join('\n') + '\n';
}

function dateOnly(d) {
  const p = (n) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
