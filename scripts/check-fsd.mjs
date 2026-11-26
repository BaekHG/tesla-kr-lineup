#!/usr/bin/env node
/*
 * check-fsd.mjs
 *
 * FSD 관련 새 소식을 여러 출처에서 모아 Supabase `fsd_news` 테이블에 넣는다.
 * Oracle 서버가 10분마다 돌린다 (GitHub raw 캐시를 거치지 않아 앱에 바로 보인다).
 *
 * 출처: 구글 뉴스(국내·해외 "FSD" 검색), Electrek, Teslarati, Not a Tesla App.
 * - 출처마다 실패해도 나머지는 계속 (한 곳 장애가 전체를 막지 않게).
 * - 같은 기사(제목이 거의 같음)는 하나만. 이미 있는 id 는 건드리지 않아 first_seen_at 유지.
 * - 30일 지난 소식은 지운다.
 *
 * env: SUPABASE_URL, SUPABASE_SECRET_KEY
 */
import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SECRET_KEY;
const KEEP_DAYS = 30;
const MAX_AGE_DAYS = 7; // 새로 넣는 건 최근 7일 기사만.

const gnews = (q, lang) =>
  lang === 'ko'
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`
    : `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// filter=false: 검색 결과라 전부 FSD 관련. true: 테슬라 전체 피드라 키워드로 거른다.
const SOURCES = [
  { url: gnews('테슬라 FSD', 'ko'), lang: 'ko', filter: false },
  { url: gnews('테슬라 자율주행 감독형', 'ko'), lang: 'ko', filter: false },
  { url: gnews('Tesla FSD', 'en'), lang: 'en', filter: false },
  { url: 'https://electrek.co/guides/tesla/feed/', lang: 'en', filter: true, source: 'Electrek' },
  { url: 'https://www.teslarati.com/feed/', lang: 'en', filter: true, source: 'Teslarati' },
  { url: 'https://www.notateslaapp.com/rss', lang: 'en', filter: true, source: 'Not a Tesla App' },
];

const FSD_RE = /\bFSD\b|full self[- ]driving|robotaxi|자율주행|로보택시|오토파일럿|autopilot/i;
const KOREA_RE = /한국|국내|korea/i;
// 개인 블로그·카페는 속보가 아니라 재가공이라 뺀다.
const BLOCKED_SOURCE_RE = /blog|블로그|tistory|카페|cafe|brunch|post\.naver/i;
const BLOCKED_URL_RE = /blog\.naver|tistory\.com|brunch\.co\.kr|cafe\.naver/i;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (typeof v === 'object' && v ? v['#text'] ?? '' : String(v ?? ''));
const decode = (s) =>
  s
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

/** 구글 뉴스 제목 끝의 " - 매체명" 을 떼고 매체명을 돌려준다. */
function splitSource(title, fallback) {
  const m = title.match(/^(.*)\s[-–]\s([^-–]{2,40})$/);
  return m ? [m[1].trim(), m[2].trim()] : [title, fallback];
}

/** 매체명 자리에 URL 이 들어오면 도메인으로. */
function cleanSource(s) {
  if (/^https?:\/\//.test(s)) {
    try {
      return new URL(s).hostname.replace(/^www\./, '').slice(0, 60);
    } catch {
      return 'Google News';
    }
  }
  return s.slice(0, 60);
}

/** 중복 판단용 키 — 문장부호·공백 제거, 앞 40자. */
const dedupeKey = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40);

async function fetchSource(src) {
  const res = await fetch(src.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (tesla-kr-lineup bot)', Accept: 'application/rss+xml, text/xml' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = asList(parser.parse(await res.text())?.rss?.channel?.item);
  const out = [];
  for (const it of items) {
    const rawTitle = decode(text(it.title));
    const url = text(it.link).trim();
    const published = Date.parse(text(it.pubDate));
    if (!rawTitle || !url.startsWith('https://') || !Number.isFinite(published)) continue;
    const [title, source] = splitSource(rawTitle, src.source ?? text(it.source) ?? 'Google News');
    // 검색 결과도 본문만 걸린 기사가 섞여서, 제목에 키워드가 있는 것만.
    if (!FSD_RE.test(title)) continue;
    if (BLOCKED_SOURCE_RE.test(source) || BLOCKED_URL_RE.test(url)) continue;
    out.push({
      id: crypto.createHash('sha1').update(url).digest('hex').slice(0, 20),
      title: title.slice(0, 300),
      url,
      source: cleanSource(decode(String(source))),
      lang: src.lang,
      is_korea: src.lang === 'ko' || KOREA_RE.test(title),
      published_at: new Date(published).toISOString(),
    });
  }
  return out;
}

async function sb(path, init = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      // sb_secret_ 키는 JWT 가 아니라 Authorization 헤더에 넣으면 거부된다.
      apikey: SB_KEY,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`supabase ${path} ${res.status}: ${await res.text()}`);
  return res;
}

async function main() {
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY 가 없어요');

  const results = await Promise.allSettled(SOURCES.map(fetchSource));
  let failed = 0;
  const all = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else {
      failed++;
      console.warn(`출처 실패: ${SOURCES[i].url} — ${r.reason?.message ?? r.reason}`);
    }
  });
  if (failed === SOURCES.length) throw new Error('모든 출처 실패');

  // 오래된 것 거르고, 같은 기사는 가장 먼저 나온 것 하나만.
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const byKey = new Map();
  for (const a of all.sort((x, y) => x.published_at.localeCompare(y.published_at))) {
    if (Date.parse(a.published_at) < cutoff) continue;
    const k = dedupeKey(a.title);
    if (!byKey.has(k)) byKey.set(k, a);
  }
  const fresh = [...byKey.values()];

  // 이미 같은 제목이 다른 url 로 들어가 있으면 건너뛴다 (출처만 다른 같은 기사).
  const recent = await (
    await sb(`fsd_news?select=title&published_at=gte.${new Date(cutoff).toISOString()}`)
  ).json();
  const known = new Set(recent.map((r) => dedupeKey(r.title)));
  const rows = fresh.filter((a) => !known.has(dedupeKey(a.title)));

  if (rows.length > 0) {
    await sb('fsd_news?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  }
  await sb(
    `fsd_news?published_at=lt.${new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString()}`,
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
  );
  console.log(`모음 ${all.length} · 후보 ${fresh.length} · 새로 ${rows.length} · 실패 출처 ${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
