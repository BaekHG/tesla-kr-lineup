#!/usr/bin/env node
/*
 * check-homepage.mjs
 *
 * tesla.com/ko_kr 주문 페이지를 실제 브라우저로 열어서 트림 이름·가격·선택 가능
 * 여부를 읽는다. 가격 API 에 없는 모델(사이버트럭)도 여기서 잡힌다.
 *
 * 홈페이지는 테슬라 공식 판매 화면이라 여기서 확인된 사실은 바로 반영한다:
 *   - override 가 직접 들고 있는 트림(add)의 가격 → 자동 수정
 *   - 선택이 막힌 트림 → hideTrims 에 추가 / 다시 열리면 제거
 *   - 세 페이지를 모두 읽었으면 lastVerified 를 오늘로
 * 판단이 필요한 것(처음 보는 트림, 단종 모델 부활 등)은 findings 로만 남긴다.
 *
 * 출력: reports/homepage-YYYY-MM-DD.json, GITHUB_OUTPUT 에 auto_changed / needs_review.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OVERRIDE_PATH = path.join(REPO_ROOT, 'lineup_overrides.json');
const TODAY = dateOnly(new Date());
const REPORT_PATH = path.join(REPO_ROOT, 'reports', `homepage-${TODAY}.json`);

// 페이지 라벨 → 로컬 trim.id. 위에서부터 먼저 맞는 규칙을 쓴다.
const PAGES = {
  model3: [
    [/Performance/i, 'model3_perf'],
    [/Long Range/i, 'model3_lr_rwd'],
    [/RWD/i, 'model3_rwd'],
  ],
  modely: [
    [/Model Y L/i, 'modely_l'],
    [/Long Range/i, 'modely_lr_awd'],
    [/RWD/i, 'modely_rwd'],
  ],
  cybertruck: [
    [/Cyberbeast/i, 'cybertruck_beast'],
    [/AWD/i, 'cybertruck_awd'],
  ],
};

// 단종 처리한 모델. 주문 페이지가 다시 열리면 사람이 봐야 한다.
const HIDDEN_MODEL_PAGES = ['models', 'modelx'];

async function main() {
  const override = JSON.parse(await fs.readFile(OVERRIDE_PATH, 'utf8'));
  // tesla.com(Akamai)은 headless 와 자동화 표식을 막는다. 실제 Chrome 을 화면 있는
  // 모드로 띄우고 자동화 플래그를 끈다. CI 에선 xvfb-run 으로 가상 화면을 준다.
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tesla-kr-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    locale: 'ko-KR',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const pages = {};
  const findings = [];
  try {
    // 첫 방문에서 Akamai 쿠키를 받아야 다음 페이지들이 열린다.
    await page.goto('https://www.tesla.com/ko_kr', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(5000);
    for (const modelId of Object.keys(PAGES)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        pages[modelId] = await readTrims(page, modelId);
        if (pages[modelId].length > 0) break;
        await page.waitForTimeout(5000);
      }
    }
    for (const modelId of HIDDEN_MODEL_PAGES) {
      const resp = await page.goto(`https://www.tesla.com/ko_kr/${modelId}/design`, {
        waitUntil: 'domcontentloaded',
      });
      const url = page.url();
      if (resp?.status() === 200 && url.includes('/design')) {
        findings.push({
          kind: 'hidden_model_orderable',
          detail: `${modelId} 주문 페이지가 다시 열림 — 재출시인지 확인 필요`,
        });
      }
    }
  } finally {
    await context.close();
  }

  // 페이지가 막혔거나 구조가 바뀌어 트림을 못 읽었으면 아무것도 고치지 않는다.
  const unreadable = Object.entries(pages).filter(([, t]) => t.length === 0);
  for (const [modelId] of unreadable) {
    findings.push({ kind: 'unreadable', detail: `${modelId} 페이지에서 트림을 못 읽음` });
  }

  const edits = [];
  for (const [modelId, trims] of Object.entries(pages)) {
    for (const t of trims) {
      if (!t.localId) {
        findings.push({
          kind: 'unknown_trim',
          detail: `${modelId}: 처음 보는 트림 "${t.label}" ₩${t.price.toLocaleString()}`,
        });
        continue;
      }
      edits.push(...syncOverrideTrim(override, t));
    }
  }

  // 모델 3/Y 는 앱이 가격 API 를 읽는다. 홈페이지와 API 가 다르면 API 가 늦은 것.
  const apiPrices = await fetchApiPrices().catch(() => null);
  if (apiPrices) {
    for (const t of [...(pages.model3 ?? []), ...(pages.modely ?? [])]) {
      if (t.localId && !apiPrices.has(t.price)) {
        findings.push({
          kind: 'api_price_mismatch',
          detail: `${t.localId}: 홈페이지 ₩${t.price.toLocaleString()} 가 가격 API 에 없음 (API 가 늦게 반영 중일 수 있음)`,
        });
      }
    }
  }

  if (unreadable.length === 0) {
    if (override.lastVerified !== TODAY) edits.push(`lastVerified → ${TODAY}`);
    override.lastVerified = TODAY;
  }

  const autoChanged = edits.length > 0 && unreadable.length === 0;
  if (autoChanged) {
    await fs.writeFile(OVERRIDE_PATH, JSON.stringify(override, null, 2) + '\n');
  }

  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(
    REPORT_PATH,
    JSON.stringify({ checkedAt: new Date().toISOString(), pages, edits, findings }, null, 2) + '\n',
  );

  console.log(JSON.stringify({ pages, edits, findings }, null, 2));
  for (const f of findings) console.log(`::warning::${f.detail}`);

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    // lastVerified 날짜만 바뀐 건 매일 커밋할 가치가 없다. 진짜 변경이 있을 때만.
    const realEdits = edits.filter((e) => !e.startsWith('lastVerified'));
    await fs.appendFile(out, `auto_changed=${autoChanged && realEdits.length > 0}\n`);
    await fs.appendFile(out, `needs_review=${findings.length > 0}\n`);
  }
}

async function readTrims(page, modelId) {
  await page.goto(`https://www.tesla.com/ko_kr/${modelId}/design`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('radio').first().waitFor({ timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const snap = await page.locator('main').ariaSnapshot().catch(() => '');

  const rules = PAGES[modelId];
  const trims = [];
  for (const line of snap.split('\n')) {
    const m = line.match(/radio "([^"]*₩([\d,]{8,})[^"]*)"(.*)$/);
    if (!m) continue;
    const label = m[1].replace(/\s+/g, ' ').trim();
    const price = Number(m[2].replaceAll(',', ''));
    // 색상·오토파일럿 같은 옵션은 1천만원 미만이라 트림과 섞이지 않는다.
    if (price < 10_000_000) continue;
    const rule = rules.find(([re]) => re.test(label));
    trims.push({
      label,
      price,
      disabled: /\[disabled\]/.test(m[3]),
      localId: rule ? rule[1] : null,
    });
  }
  return trims;
}

/** 가격 API 의 모델 3/Y 가격 집합. 코드가 바뀌어도 비교되게 가격으로만 본다. */
async function fetchApiPrices() {
  const r = await fetch('https://apigateway-pricing-gateway.tesla.com/pricing/v2/KR?region=KR');
  if (!r.ok) throw new Error(`pricing api ${r.status}`);
  const kr = (await r.json())?.KR ?? {};
  const prices = new Map();
  for (const key of ['m3', 'my']) {
    for (const t of kr[key] ?? []) {
      const p = t?.cash?.price;
      if (p) prices.set(p, t.trim_code);
    }
  }
  return prices;
}

/** override 가 들고 있는 트림만 고친다. 모델 3/Y 가격은 앱이 가격 API 로 직접 받는다. */
function syncOverrideTrim(override, t) {
  const edits = [];
  override.hideTrims ??= [];
  override.trimNotes ??= {};

  for (const model of override.add ?? []) {
    const trim = model.trims.find((x) => x.id === t.localId);
    if (!trim) continue;
    if (trim.price !== t.price) {
      edits.push(`${t.localId} 가격 ${trim.price} → ${t.price}`);
      trim.price = t.price;
    }
  }

  const hidden = override.hideTrims.includes(t.localId);
  if (t.disabled && !hidden) {
    override.hideTrims.push(t.localId);
    override.trimNotes[t.localId] ??= `${TODAY.slice(0, 7).replace('-', '년 ')}월 주문 종료`;
    edits.push(`${t.localId} 주문 막힘 → hideTrims 추가`);
  } else if (!t.disabled && hidden) {
    override.hideTrims = override.hideTrims.filter((id) => id !== t.localId);
    delete override.trimNotes[t.localId];
    edits.push(`${t.localId} 주문 다시 열림 → hideTrims 제거`);
  }
  return edits;
}

function dateOnly(d) {
  const p = (n) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
