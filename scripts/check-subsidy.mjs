#!/usr/bin/env node
/*
 * check-subsidy.mjs
 *
 * 무공해차 통합누리집(ev.or.kr) "구매보조금 지급 현황" 에서 지역별 전기승용
 * 보조금 대수(공고·접수·선정·출고·잔여)를 읽어 subsidy_status.json 으로 저장한다.
 *
 * - 일반 HTTP 요청은 봇 차단 JS 챌린지 화면이 와서 실제 브라우저(headless OK)로 연다.
 * - 표는 AG Grid 라 페이지 이동 시 추가 요청이 없다 → 페이지를 넘기며 셀을 읽는다.
 * - 같은 지역이 공고(본공고/추경N차)마다 행으로 반복되고 대수는 지역 합계라
 *   지역 단위로 묶고 공고는 목록으로 둔다.
 *
 * 출력: subsidy_status.json (앱이 raw URL 로 읽음), GITHUB_OUTPUT 에 has_changes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT_PATH = path.join(REPO_ROOT, 'subsidy_status.json');
const SOURCE_URL = 'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do';

const num = (s) => {
  const n = Number(String(s ?? '').replace(/[^0-9-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function readPage(page) {
  return page.$$eval('[role=row][row-index]', (rows) =>
    rows.map((r) =>
      Object.fromEntries(
        [...r.querySelectorAll('[role=gridcell]')].map((c) => [
          c.getAttribute('col-id'),
          c.innerText.trim(),
        ]),
      ),
    ),
  );
}

async function scrape() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: 'ko-KR' });
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 90_000 });
    await page.waitForSelector('[role=row][row-index]', { timeout: 60_000 });

    const bodyText = await page.locator('body').innerText();
    const expected = num(bodyText.match(/총\s*([\d,]+)\s*건/)?.[1]);

    const seen = new Map();
    for (let n = 1; n <= 60; n++) {
      if (n > 1) {
        const link = page.locator(`a.pagination__link[data-num="${n}"]`);
        if ((await link.count()) === 0) {
          // 페이지 번호 묶음(1~5) 밖이면 "다음" 으로 다음 묶음을 연다.
          const next = page.getByRole('link', { name: '다음' }).or(
            page.getByRole('button', { name: '다음' }),
          );
          if ((await next.count()) === 0) break;
          await next.first().click();
          await page.waitForTimeout(600);
          if ((await link.count()) === 0) break;
        }
        await link.first().click();
        await page.waitForTimeout(600);
      }
      const rows = await readPage(page);
      let added = 0;
      for (const r of rows) {
        const key = [r.sido, r.noticeKind, r.period].join('|');
        if (!seen.has(key)) {
          seen.set(key, r);
          added++;
        }
      }
      if (added === 0) break;
      // "총 N건" 은 지역 수 (공고 행 수 아님).
      const regionCount = new Set([...seen.values()].map((r) => r.sido)).size;
      if (expected && regionCount >= expected) break;
    }
    return { rows: [...seen.values()], expected };
  } finally {
    await browser.close();
  }
}

/** "즐겨찾기\n서울\n마감\n서울특별시" → { short:'서울', name:'서울특별시', closed:true } */
function parseRegion(cell) {
  const parts = String(cell)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && s !== '즐겨찾기');
  const closed = parts.includes('마감');
  const rest = parts.filter((s) => s !== '마감');
  return { short: rest[0] ?? '', name: rest[rest.length - 1] ?? '', closed };
}

function group(rows) {
  const regions = new Map();
  for (const r of rows) {
    if (!/승용/.test(r.carNm ?? '')) continue;
    const reg = parseRegion(r.sido);
    // 고성군(강원·경남)처럼 이름이 겹치는 곳이 있어 시도까지 키에 넣는다.
    const key = `${reg.short}|${reg.name}`;
    if (!reg.name) continue;
    if (!regions.has(key)) {
      regions.set(key, {
        region: reg.name,
        short: reg.short,
        closed: reg.closed,
        deadline: r.deadline || null,
        announced: num(r.stepCnt),
        received: num(r.recei),
        selected: num(r.choice),
        released: num(r.relea),
        selectionRemaining: num(r.choiceRemain),
        releaseRemaining: num(r.resi),
        notices: [],
      });
    }
    regions.get(key).notices.push({
      kind: String(r.noticeKind ?? '').replace(/[[\]]/g, ''),
      period: r.period || null,
    });
  }
  return [...regions.values()];
}

async function main() {
  const { rows, expected } = await scrape();
  if (rows.length === 0) throw new Error('표를 한 줄도 못 읽었어요 (페이지 구조 변경?)');
  const regions = group(rows);
  if (expected && regions.length < expected) {
    // 일부만 읽혔으면 덮어쓰지 않는다 — 앱에 지역이 사라져 보이면 안 됨.
    throw new Error(`${expected}곳 중 ${regions.length}곳만 읽음`);
  }

  let prev = null;
  try {
    prev = JSON.parse(await fs.readFile(OUT_PATH, 'utf8'));
  } catch {}
  const changed =
    !prev || JSON.stringify(prev.regions) !== JSON.stringify(regions);

  const out = {
    schemaVersion: 1,
    source: SOURCE_URL,
    year: new Date().getFullYear(),
    carType: '전기승용',
    // 숫자가 그대로면 날짜도 그대로 둬서 불필요한 커밋을 막는다.
    updatedAt: changed ? new Date().toISOString() : prev.updatedAt,
    regions,
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`지역 ${regions.length}/${expected ?? '?'}곳 (공고 ${rows.length}건) · 변경 ${changed}`);

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `has_changes=${changed}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
