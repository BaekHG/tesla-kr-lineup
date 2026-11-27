#!/usr/bin/env node
/*
 * tesla-sync.mjs
 *
 * 테슬라 계정을 연결한 사용자마다 차 상태·충전 기록을 Fleet API 에서 받아 Supabase 에 넣는다.
 * Oracle 서버가 30분마다 돌린다. 앱은 Supabase 에서 자기 행만 읽는다.
 *
 * 비용을 아끼려고 차를 깨우지 않는다: 차 목록에서 state 가 online 일 때만 vehicle_data 를 부른다.
 *   - 슈퍼차저: /api/1/dx/charging/history → 실제 요금(원)까지.
 *   - 집·완속: 직전 상태가 Charging 이었다가 끝났으면 charge_energy_added(kWh)로 세션을 만든다
 *     (금액은 앱이 요금표로 추정).
 *   - 주행거리·배터리(100% 환산 주행가능거리)·소프트웨어 버전.
 *
 * env: TESLA_CLIENT_ID, SUPABASE_URL, SUPABASE_SECRET_KEY (선택: TESLA_AUDIENCE)
 * TESLA_CLIENT_ID 가 없으면(개발자 앱 등록 전) 아무것도 안 하고 끝난다.
 */
const CLIENT_ID = process.env.TESLA_CLIENT_ID;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SECRET_KEY;
const AUDIENCE = process.env.TESLA_AUDIENCE ?? 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const MI_TO_KM = 1.609344;

async function sb(path, init = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`supabase ${path} ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

const upsert = (table, rows, onConflict) =>
  sb(`${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });

async function refreshIfNeeded(link) {
  if (Date.parse(link.expires_at) - Date.now() > 10 * 60_000) return link;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: link.refresh_token }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`refresh ${res.status}`);
  const t = await res.json();
  // 리프레시 토큰은 한 번 쓰면 끝 → 새로 받은 걸 바로 저장.
  const next = {
    ...link,
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? link.refresh_token,
    expires_at: new Date(Date.now() + (t.expires_in ?? 28800) * 1000).toISOString(),
  };
  await sb(`tesla_links?user_id=eq.${link.user_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ access_token: next.access_token, refresh_token: next.refresh_token, expires_at: next.expires_at }),
  });
  return next;
}

async function api(link, path) {
  const res = await fetch(`${AUDIENCE}${path}`, {
    headers: { Authorization: `Bearer ${link.access_token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 408) return null; // 차가 자는 중
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json())?.response ?? null;
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

async function syncOne(link) {
  link = await refreshIfNeeded(link);
  const vehicles = (await api(link, '/api/1/vehicles')) ?? [];
  const v = vehicles.find((x) => x.vin === link.vin) ?? vehicles[0];
  if (!v) return 'no vehicle';

  // 슈퍼차저 기록 (차를 깨우지 않는 계정 단위 API).
  const history = (await api(link, `/api/1/dx/charging/history?vin=${v.vin}&pageSize=50`)) ?? {};
  const sessions = [];
  for (const s of history.data ?? []) {
    const fees = s.fees ?? [];
    const charging = fees.filter((f) => f.feeType === 'CHARGING');
    const krw = fees.filter((f) => f.currencyCode === 'KRW').reduce((a, f) => a + (Number(f.totalDue) || 0), 0);
    sessions.push({
      user_id: link.user_id,
      id: `sc_${s.sessionId}`,
      vin: v.vin,
      kind: 'supercharger',
      started_at: s.chargeStartDateTime,
      ended_at: s.chargeStopDateTime ?? null,
      kwh: charging.reduce((a, f) => a + (Number(f.usageBase) || 0), 0) || null,
      cost_krw: krw > 0 ? Math.round(krw) : null,
      site: s.siteLocationName ?? null,
    });
  }

  let note = `sc ${sessions.length}`;
  if (v.state === 'online') {
    const data = await api(link, `/api/1/vehicles/${v.vin}/vehicle_data?endpoints=charge_state%3Bvehicle_state`);
    if (data) {
      const cs = data.charge_state ?? {};
      const vs = data.vehicle_state ?? {};
      const [prev] =
        (await sb(`tesla_vehicle_state?user_id=eq.${link.user_id}&select=charging_state,charge_energy_added`)) ?? [];
      const level = cs.battery_level ?? null;
      const rangeKm = cs.battery_range != null ? cs.battery_range * MI_TO_KM : null;
      // 집·완속 충전이 끝났으면 세션 하나 (슈퍼차저는 위 기록으로 잡힌다).
      if (prev?.charging_state === 'Charging' && cs.charging_state !== 'Charging' && Number(prev.charge_energy_added) > 0 &&
        cs.fast_charger_type !== 'Tesla') {
        sessions.push({
          user_id: link.user_id,
          id: `ot_${v.vin}_${Date.now()}`,
          vin: v.vin,
          kind: 'other',
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
          kwh: round1(Number(prev.charge_energy_added)),
          cost_krw: null,
          site: null,
        });
      }
      await upsert('tesla_vehicle_state', [{
        user_id: link.user_id,
        vin: v.vin,
        odometer_km: vs.odometer != null ? round1(vs.odometer * MI_TO_KM) : null,
        battery_level: level,
        rated_range_km: round1(rangeKm),
        full_range_km: level != null && level >= 50 && rangeKm != null ? round1(rangeKm / (level / 100)) : null,
        charging_state: cs.charging_state ?? null,
        charge_energy_added: cs.charge_energy_added ?? null,
        software_version: vs.car_version ?? null,
        updated_at: new Date().toISOString(),
      }], 'user_id');
      note += ' · state';
    }
  } else {
    note += ` · ${v.state} (안 깨움)`;
  }
  if (sessions.length) await upsert('tesla_charging_sessions', sessions, 'user_id,id');
  await sb(`tesla_links?user_id=eq.${link.user_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_sync_at: new Date().toISOString(), last_error: null, vin: v.vin, vehicle_name: v.display_name ?? null }),
  });
  return note;
}

async function main() {
  if (!CLIENT_ID) {
    console.log('TESLA_CLIENT_ID 없음 — 테슬라 개발자 앱 등록 전이라 건너뜀');
    return;
  }
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY 가 없어요');
  const links = (await sb('tesla_links?select=*')) ?? [];
  let ok = 0;
  for (const link of links) {
    try {
      console.log(`${link.user_id.slice(0, 8)} ${await syncOne(link)}`);
      ok++;
    } catch (e) {
      console.warn(`${link.user_id.slice(0, 8)} 실패: ${e.message}`);
      await sb(`tesla_links?user_id=eq.${link.user_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_error: String(e.message).slice(0, 200) }),
      }).catch(() => {});
    }
  }
  console.log(`연결 ${links.length}명 · 성공 ${ok}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
