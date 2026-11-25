#!/usr/bin/env node
/*
 * check-vessels.mjs
 *
 * 관세청 UNI-PASS 화물통관진행정보(API001)로 평택항에 들어온 테슬라 운반선을 찾아
 * 차종별 대수 · 통관 · 반출 진행률을 vessels.json 으로 저장한다.
 *
 * 찾는 방법:
 *   - 글로비스 평택 수입 MRN 은 `26GLVSP###I` 처럼 일련번호가 순서대로 붙는다.
 *   - 마지막으로 찾은 번호 앞뒤를 훑어서 새 배를 찾는다 (입항보고 API 없이).
 *   - 선적항 상하이(CNSHA) + 화물명 MOTOR VEHICLES 인 배만 테슬라로 본다.
 *   - 화물관리번호 = MRN + MSN(4자리). MSN 0001 부터 비어 있을 때까지 읽는다.
 *   - 차마다 수입신고 행에 무게가 따로 찍혀서 무게로 차종을 나눈다.
 *
 * env: CUSTOMS_KEY_CARGO (API001 인증키)
 * 출력: vessels.json, GITHUB_OUTPUT 에 has_changes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT_PATH = path.join(REPO_ROOT, 'vessels.json');
const KEY = process.env.CUSTOMS_KEY_CARGO;
const API =
  'https://unipass.customs.go.kr:38010/ext/rest/cargCsclPrgsInfoQry/retrieveCargCsclPrgsInfo';

// 첫 실행 기준점. 이후엔 vessels.json 의 마지막 번호부터.
const SEED_SEQ = 350;
const LOOK_BACK = 10;
const LOOK_AHEAD = 40;
const KEEP_DAYS = 60;

// 1대당 무게(kg) → 차종. 세관 신고 무게라 트림마다 고정값.
const MODEL_BY_KG = {
  1735: '모델 3 RWD',
  1760: '모델 3 RWD',
  1855: '모델 3 퍼포먼스',
  1920: '모델 Y RWD',
  1990: '모델 Y 롱레인지 AWD',
  2090: '모델 Y L',
};

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function query(cargMtNo) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API}?crkyCn=${KEY}&cargMtNo=${cargMtNo}`, {
        signal: AbortSignal.timeout(30_000),
      });
      const root = parser.parse(await res.text()).cargCsclPrgsInfoQryRtnVo;
      if (!root) throw new Error('응답 형식이 달라요');
      const info = root.cargCsclPrgsInfoQryVo;
      if (!info) return null;
      return { info, details: asList(root.cargCsclPrgsInfoDtlQryVo) };
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(2000);
    }
  }
}

const mrnOf = (yy, seq) => `${yy}GLVSP${String(seq).padStart(3, '0')}I`;

// 한 배에 BYD·뷰익·포드 등이 섞여 실린다. 상하이 선적 + "(TESLA) MOTOR VEHICLES" 묶음만 테슬라.
const isTeslaLot = (info) =>
  info.ldprCd === 'CNSHA' && /^(TESLA )?MOTOR VEHICLES?$/i.test(String(info.prnm ?? '').trim());

/**
 * MRN 하나의 화물 묶음(MSN)을 끝까지 읽어 테슬라 묶음만 합친다.
 * 반환: undefined = 그런 MRN 없음, null = 있지만 테슬라 없음.
 */
async function readVessel(mrn) {
  const byModel = new Map();
  let head = null;
  let total = 0;
  let cleared = 0;
  let released = 0;
  let lastEvent = null;
  for (let msn = 1; msn <= 400; msn++) {
    const r = await query(`${mrn}${String(msn).padStart(4, '0')}`);
    if (!r) {
      if (msn === 1) return undefined;
      break;
    }
    await sleep(150);
    if (!isTeslaLot(r.info)) continue;
    head ??= r.info;
    total += Number(r.info.pckGcnt) || 0;
    for (const d of r.details) {
      const kind = d.cargTrcnRelaBsopTpcd;
      const n = Number(d.pckGcnt) || 0;
      if (kind === '수입신고') {
        const kg = Number(d.wght) || 0;
        const name = MODEL_BY_KG[kg] ?? `기타 (${kg}kg)`;
        byModel.set(name, (byModel.get(name) ?? 0) + n);
      } else if (kind === '수입신고수리') {
        cleared += n;
      } else if (kind === '반출신고') {
        released += n;
      }
      if (d.prcsDttm && (!lastEvent || d.prcsDttm > lastEvent)) lastEvent = d.prcsDttm;
    }
  }
  if (!head) return null;

  const d = String(head.etprDt);
  return {
    mrn,
    ship: head.shipNm,
    loadPort: head.ldprNm,
    port: head.dsprNm,
    arrivalDate: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
    totalCars: total,
    cleared,
    released,
    models: [...byModel.entries()]
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count),
    lastEventAt: lastEvent,
  };
}

async function main() {
  if (!KEY) throw new Error('CUSTOMS_KEY_CARGO 가 없어요');

  let prev = null;
  try {
    prev = JSON.parse(await fs.readFile(OUT_PATH, 'utf8'));
  } catch {}

  const yy = String(new Date().getFullYear()).slice(2);
  const known = (prev?.vessels ?? []).filter((v) => v.mrn.startsWith(yy));
  // 첫 실행이면 기준점부터 넉넉히, 이후엔 마지막 번호 앞뒤만.
  const lastSeq = known.length
    ? Math.max(...known.map((v) => Number(v.mrn.slice(7, 10))))
    : null;

  // 이미 반출 끝난 배는 다시 안 읽는다.
  const done = new Map(
    (prev?.vessels ?? [])
      .filter((v) => v.totalCars > 0 && v.released >= v.totalCars)
      .map((v) => [v.mrn, v]),
  );

  const found = new Map(done);
  // 존재하는 MRN(테슬라 아니어도)이 나올 때마다 끝을 늘린다 → 뒤로 LOOK_AHEAD 개 연속 빌 때 멈춤.
  const from = lastSeq == null ? SEED_SEQ : Math.max(1, lastSeq - LOOK_BACK);
  let frontier = lastSeq ?? SEED_SEQ;
  for (let seq = from; seq <= frontier + LOOK_AHEAD; seq++) {
    const mrn = mrnOf(yy, seq);
    if (done.has(mrn)) {
      frontier = Math.max(frontier, seq);
      continue;
    }
    const v = await readVessel(mrn);
    if (v !== undefined) frontier = Math.max(frontier, seq);
    if (v) {
      found.set(mrn, v);
      console.log(`${mrn} ${v.ship} ${v.arrivalDate} ${v.released}/${v.totalCars}`);
    }
    await sleep(200);
  }

  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const vessels = [...found.values()]
    .filter((v) => Date.parse(v.arrivalDate) >= cutoff)
    .sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));

  if (vessels.length === 0 && (prev?.vessels?.length ?? 0) > 0) {
    // 전부 사라졌으면 API 쪽 문제일 가능성이 커서 덮어쓰지 않는다.
    throw new Error('배를 하나도 못 찾았어요 (기존 파일 유지)');
  }

  const changed = JSON.stringify(prev?.vessels) !== JSON.stringify(vessels);
  const out = {
    schemaVersion: 1,
    source: 'UNI-PASS 화물통관진행정보',
    updatedAt: changed ? new Date().toISOString() : prev.updatedAt,
    vessels,
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`배 ${vessels.length}척 · 변경 ${changed}`);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `has_changes=${changed}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
