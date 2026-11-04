/* Bầu Trời Sống — không khí, thời tiết, bản đồ thời gian thực & nhật ký biến động.
   Dữ liệu: Open-Meteo (thời tiết + chất lượng không khí CAMS), RainViewer (radar mưa),
   BigDataCloud (tên địa điểm), bản đồ nền CARTO/OpenStreetMap. Không cần API key. */
'use strict';

const API = {
  aq: 'https://air-quality-api.open-meteo.com/v1/air-quality',
  wx: 'https://api.open-meteo.com/v1/forecast',
  geo: 'https://geocoding-api.open-meteo.com/v1/search',
  rev: 'https://api.bigdatacloud.net/data/reverse-geocode-client',
  radar: 'https://api.rainviewer.com/public/weather-maps.json',
};
const REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_LOC = { lat: 21.0285, lon: 105.8542, name: 'Hà Nội', sub: 'Việt Nam' };

/* ---------- Tiện ích ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const fmt = (v, d = 0) => (v == null || Number.isNaN(v)) ? '—' : Number(v).toLocaleString('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: d });
const pad = n => String(n).padStart(2, '0');
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// thời gian địa phương dạng "2026-11-04T17:00" (do timezone=auto) → nhãn
const tLabel = s => s ? s.slice(11, 16) : '—';
const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const dayLabel = (s, i) => { if (i === 0) return 'Hôm nay'; if (i === 1) return 'Ngày mai'; const d = new Date(s + 'T12:00'); return DOW[d.getDay()]; };
const locKey = l => `${l.lat.toFixed(2)},${l.lon.toFixed(2)}`;

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms);
}
async function getJSON(url, timeout = 15000) {
  const ctl = new AbortController(); const id = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(id); }
}

/* ---------- AQI ---------- */
const AQI_LEVELS = [
  { max: 50, name: 'Tốt', color: '#22B14C', ink: '#06280F', advice: 'Không khí trong lành. Thoải mái hoạt động ngoài trời.' },
  { max: 100, name: 'Trung bình', color: '#F2D00A', ink: '#332B00', advice: 'Chấp nhận được. Người rất nhạy cảm nên hạn chế vận động mạnh ngoài trời lâu.' },
  { max: 150, name: 'Kém', color: '#FF8A1F', ink: '#2E1400', advice: 'Người nhạy cảm (trẻ em, người già, bệnh hô hấp/tim mạch) nên giảm hoạt động ngoài trời.' },
  { max: 200, name: 'Xấu', color: '#E5322D', ink: '#FFFFFF', advice: 'Mọi người nên hạn chế ra ngoài; đeo khẩu trang lọc bụi mịn (N95/KN95) khi cần ra đường.' },
  { max: 300, name: 'Rất xấu', color: '#8F3F97', ink: '#FFFFFF', advice: 'Cảnh báo sức khỏe: tránh hoạt động ngoài trời, đóng cửa sổ, dùng máy lọc không khí.' },
  { max: Infinity, name: 'Nguy hại', color: '#7E0023', ink: '#FFFFFF', advice: 'Khẩn cấp: ở trong nhà, đóng kín cửa, dùng máy lọc; người nhạy cảm cần theo dõi sức khỏe.' },
];
const aqiLevel = v => AQI_LEVELS[AQI_LEVELS.findIndex(l => v <= l.max)] || AQI_LEVELS[5];
const aqiIdx = v => AQI_LEVELS.findIndex(l => v <= l.max);

const POLLUTANTS = [
  { k: 'pm2_5', sub: 'us_aqi_pm2_5', name: 'PM2.5', full: 'Bụi mịn ≤2,5µm', unit: 'µg/m³', d: 1 },
  { k: 'pm10', sub: 'us_aqi_pm10', name: 'PM10', full: 'Bụi ≤10µm', unit: 'µg/m³', d: 0 },
  { k: 'ozone', sub: 'us_aqi_ozone', name: 'O₃', full: 'Ozone', unit: 'µg/m³', d: 0 },
  { k: 'nitrogen_dioxide', sub: 'us_aqi_nitrogen_dioxide', name: 'NO₂', full: 'Nitơ đioxit', unit: 'µg/m³', d: 1 },
  { k: 'sulphur_dioxide', sub: 'us_aqi_sulphur_dioxide', name: 'SO₂', full: 'Lưu huỳnh đioxit', unit: 'µg/m³', d: 1 },
  { k: 'carbon_monoxide', sub: 'us_aqi_carbon_monoxide', name: 'CO', full: 'Cacbon monoxit', unit: 'µg/m³', d: 0 },
  { k: 'dust', name: 'Bụi cát', full: 'Bụi khoáng', unit: 'µg/m³', d: 0 },
  { k: 'uv_index', name: 'UV', full: 'Chỉ số tia cực tím', unit: '', d: 1 },
];

/* ---------- Thời tiết ---------- */
const WMO = {
  0: 'Trời quang', 1: 'Gần như quang', 2: 'Có mây rải rác', 3: 'Nhiều mây', 45: 'Sương mù', 48: 'Sương mù đóng băng',
  51: 'Mưa phùn nhẹ', 53: 'Mưa phùn', 55: 'Mưa phùn dày', 56: 'Mưa phùn lạnh', 57: 'Mưa phùn lạnh dày',
  61: 'Mưa nhỏ', 63: 'Mưa vừa', 65: 'Mưa to', 66: 'Mưa lạnh', 67: 'Mưa lạnh to',
  71: 'Tuyết nhẹ', 73: 'Tuyết', 75: 'Tuyết dày', 77: 'Hạt tuyết', 80: 'Mưa rào nhẹ', 81: 'Mưa rào', 82: 'Mưa rào rất to',
  85: 'Mưa tuyết', 86: 'Mưa tuyết to', 95: 'Dông', 96: 'Dông kèm mưa đá', 99: 'Dông mạnh, mưa đá',
};
const isRainCode = c => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
const DIRS = ['Bắc', 'Đông Bắc', 'Đông', 'Đông Nam', 'Nam', 'Tây Nam', 'Tây', 'Tây Bắc'];
const DIRS_S = ['B', 'ĐB', 'Đ', 'ĐN', 'N', 'TN', 'T', 'TB'];
const dirName = (deg, short) => (short ? DIRS_S : DIRS)[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

function wxIcon(code, day = 1) {
  const sun = `<circle cx="32" cy="28" r="11" fill="#F7B731"/><g stroke="#F7B731" stroke-width="3" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315].map(a => { const r = a * Math.PI / 180; return `<line x1="${32 + Math.cos(r) * 15}" y1="${28 + Math.sin(r) * 15}" x2="${32 + Math.cos(r) * 19}" y2="${28 + Math.sin(r) * 19}"/>`; }).join('')}</g>`;
  const moon = `<path d="M38 14a14 14 0 1 0 10 22A12 12 0 0 1 38 14Z" fill="#C9D6E8"/>`;
  const cloud = (f = '#B9C6D3', y = 0) => `<path transform="translate(0 ${y})" d="M20 50a10 10 0 0 1-1-19.9A13 13 0 0 1 44 27a9.5 9.5 0 0 1 1 23H20Z" fill="${f}"/>`;
  const drops = n => `<g stroke="#3B8FE0" stroke-width="3" stroke-linecap="round">${Array.from({ length: n }, (_, i) => `<line x1="${24 + i * 8}" y1="54" x2="${21 + i * 8}" y2="61"/>`).join('')}</g>`;
  const bolt = `<path d="M34 46l-7 11h6l-3 7 9-12h-6l3-6z" fill="#F7B731"/>`;
  const snow = `<g fill="#9FC4EA">${[24, 32, 40].map(x => `<circle cx="${x}" cy="58" r="2.5"/>`).join('')}</g>`;
  const fog = `<g stroke="#9AA8B6" stroke-width="3" stroke-linecap="round"><line x1="14" y1="40" x2="50" y2="40"/><line x1="18" y1="48" x2="46" y2="48"/><line x1="14" y1="56" x2="42" y2="56"/></g>`;
  const sky = day ? sun : moon;
  let body;
  if (code === 0) body = sky;
  else if (code <= 2) body = `<g transform="translate(-6 -6) scale(.85)">${sky}</g>${cloud('#C7D2DD', 4)}`;
  else if (code === 3) body = cloud('#A9B6C3');
  else if (code === 45 || code === 48) body = cloud('#B9C6D3', -8) + fog;
  else if (code >= 95) body = cloud('#7D8A98', -4) + bolt;
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) body = cloud('#B9C6D3', -4) + snow;
  else if (code >= 51) body = cloud(code >= 63 && code !== 80 ? '#8E9BA8' : '#B0BCC8', -4) + drops(code === 65 || code === 82 ? 4 : code >= 61 ? 3 : 2);
  else body = cloud();
  return `<svg viewBox="0 0 64 64" aria-label="${esc(WMO[code] || '')}" role="img">${body}</svg>`;
}

/* ---------- Trạng thái ---------- */
const S = {
  loc: store.get('bt-loc', null),
  aq: null, wx: null, lastOk: 0, nextAt: 0, tab: 'air', aqMetric: 'us_aqi',
  favs: store.get('bt-favs', []),
  events: store.get('bt-events', []),
  loading: false,
};

/* ---------- Tải dữ liệu ---------- */
const AQ_CUR = 'us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,dust,uv_index,us_aqi_pm2_5,us_aqi_pm10,us_aqi_ozone,us_aqi_nitrogen_dioxide,us_aqi_sulphur_dioxide,us_aqi_carbon_monoxide';
const AQ_HR = 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide';
const WX_CUR = 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const WX_HR = 'temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,visibility,uv_index,is_day,pressure_msl';
const WX_DAY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_speed_10m_max';

async function loadAll({ silent = false } = {}) {
  if (!S.loc || S.loading) return;
  S.loading = true; $('#refreshBtn').classList.add('spin');
  const { lat, lon } = S.loc;
  const q = `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&timezone=auto`;
  try {
    const [aq, wx] = await Promise.all([
      getJSON(`${API.aq}?${q}&current=${AQ_CUR}&hourly=${AQ_HR}&past_days=1&forecast_days=2`),
      getJSON(`${API.wx}?${q}&current=${WX_CUR}&hourly=${WX_HR}&daily=${WX_DAY}&past_days=1&forecast_days=7&wind_speed_unit=kmh`),
    ]);
    S.aq = aq; S.wx = wx; S.lastOk = Date.now();
    store.set('bt-cache', { key: locKey(S.loc), aq, wx, t: S.lastOk });
    recordSnapshot();
    setLive('on');
    renderAll();
    if (S.map) refreshMapData();
  } catch (e) {
    console.warn(e);
    setLive('err');
    if (!S.aq) { // dùng bản lưu cuối nếu có
      const c = store.get('bt-cache', null);
      if (c && c.key === locKey(S.loc)) { S.aq = c.aq; S.wx = c.wx; S.lastOk = c.t; renderAll(); }
    }
    if (!silent) toast(navigator.onLine ? 'Không tải được dữ liệu, sẽ thử lại.' : 'Đang ngoại tuyến — hiển thị dữ liệu đã lưu.');
  } finally {
    S.loading = false; $('#refreshBtn').classList.remove('spin');
    S.nextAt = Date.now() + REFRESH_MS;
  }
}

function setLive(state) {
  const el = $('#liveDot'); el.className = 'live ' + (state || '');
  updateLiveText();
}
function updateLiveText() {
  const el = $('#liveText');
  if (!S.lastOk) { el.textContent = 'Đang kết nối…'; return; }
  const ago = Math.round((Date.now() - S.lastOk) / 60000);
  const aqT = S.aq?.current?.time ? tLabel(S.aq.current.time) : '';
  const wxT = S.wx?.current?.time ? tLabel(S.wx.current.time) : '';
  const err = $('#liveDot').classList.contains('err');
  el.textContent = `${err ? 'Mất kết nối · ' : 'Trực tiếp · '}tải lúc ${hhmm(new Date(S.lastOk))}${ago > 0 ? ` (${ago} phút trước)` : ''}${wxT ? ` · số liệu ${wxT}` : ''}`;
  el.title = `Không khí: ${aqT} · Thời tiết: ${wxT} (giờ địa phương)`;
  const left = Math.max(0, S.nextAt - Date.now());
  $('#nextText').textContent = S.nextAt ? `Tự làm mới sau ${Math.floor(left / 60000)}:${pad(Math.floor(left / 1000) % 60)}` : '';
}

/* chỉ số giờ hiện tại trong mảng hourly */
function hourIndex(h, curTime) {
  if (!h || !curTime) return -1;
  const key = curTime.slice(0, 13) + ':00';
  let i = h.time.indexOf(key);
  if (i < 0) { i = h.time.findIndex(t => t > curTime) - 1; }
  return i;
}
const valAgo = (h, k, i, n) => (i - n >= 0 ? h[k][i - n] : null);

/* ---------- Ghi nhận & phát hiện thay đổi ---------- */
function snapshotNow() {
  const a = S.aq?.current || {}, w = S.wx?.current || {};
  return {
    t: Date.now(), aqT: a.time, wxT: w.time,
    aqi: a.us_aqi, pm25: a.pm2_5, pm10: a.pm10, o3: a.ozone, no2: a.nitrogen_dioxide,
    temp: w.temperature_2m, hum: w.relative_humidity_2m, wind: w.wind_speed_10m, gust: w.wind_gusts_10m,
    rain: w.precipitation, code: w.weather_code, pres: w.pressure_msl, cloud: w.cloud_cover,
  };
}
function recordSnapshot() {
  const key = 'bt-hist-' + locKey(S.loc);
  const hist = store.get(key, []);
  const cur = snapshotNow();
  const prev = hist[hist.length - 1];
  if (prev && prev.aqT === cur.aqT && prev.wxT === cur.wxT) { prev.t = cur.t; store.set(key, hist); return; } // chưa có số liệu mới
  if (prev) detectChanges(prev, cur);
  hist.push(cur);
  while (hist.length > 500) hist.shift();
  store.set(key, hist);
}
function pushEvent(icon, text, kind = 'info') {
  const ev = { t: Date.now(), icon, text, place: S.loc.name, kind };
  S.events.unshift(ev); S.events = S.events.slice(0, 200);
  store.set('bt-events', S.events);
  if (store.get('bt-notify', false) && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(`${S.loc.name}: ${text}`, { icon: 'icon-192.png', tag: 'bt-' + kind }); } catch {}
  }
}
function detectChanges(p, c) {
  if (p.aqi != null && c.aqi != null) {
    const a = aqiIdx(p.aqi), b = aqiIdx(c.aqi);
    if (a !== b) pushEvent(b > a ? '😷' : '🌿', `Không khí chuyển từ “${AQI_LEVELS[a].name}” sang “${AQI_LEVELS[b].name}” (AQI ${Math.round(p.aqi)} → ${Math.round(c.aqi)})`, 'aqi');
    else if (Math.abs(c.aqi - p.aqi) >= 8) pushEvent(c.aqi > p.aqi ? '↗' : '↘', `AQI ${c.aqi > p.aqi ? 'tăng' : 'giảm'} ${Math.round(Math.abs(c.aqi - p.aqi))} điểm, hiện ${Math.round(c.aqi)}`, 'aqi');
  }
  if (p.pm25 != null && c.pm25 != null && Math.abs(c.pm25 - p.pm25) >= 10) pushEvent('🌫', `PM2.5 ${c.pm25 > p.pm25 ? 'tăng' : 'giảm'} từ ${fmt(p.pm25, 1)} → ${fmt(c.pm25, 1)} µg/m³`, 'pm');
  const pr = isRainCode(p.code) || p.rain > 0, cr = isRainCode(c.code) || c.rain > 0;
  if (!pr && cr) pushEvent('🌧', `Bắt đầu ${(WMO[c.code] || 'mưa').toLowerCase()}`, 'rain');
  else if (pr && !cr) pushEvent('🌤', 'Đã tạnh mưa', 'rain');
  else if (p.code !== c.code && WMO[c.code]) pushEvent('☁', `Thời tiết: ${WMO[p.code] || '?'} → ${WMO[c.code]}`, 'wx');
  if (p.temp != null && Math.abs(c.temp - p.temp) >= 1.5) pushEvent('🌡', `Nhiệt độ ${c.temp > p.temp ? 'tăng' : 'giảm'} ${fmt(Math.abs(c.temp - p.temp), 1)}°C, hiện ${fmt(c.temp, 1)}°C`, 'temp');
  if (p.wind != null && Math.abs(c.wind - p.wind) >= 8) pushEvent('💨', `Gió ${c.wind > p.wind ? 'mạnh lên' : 'yếu đi'}: ${fmt(p.wind)} → ${fmt(c.wind)} km/h`, 'wind');
  if (c.gust >= 50 && !(p.gust >= 50)) pushEvent('⚠', `Gió giật mạnh ${fmt(c.gust)} km/h`, 'warn');
  if (p.hum != null && Math.abs(c.hum - p.hum) >= 12) pushEvent('💧', `Độ ẩm ${c.hum > p.hum ? 'tăng' : 'giảm'}: ${fmt(p.hum)}% → ${fmt(c.hum)}%`, 'hum');
}

/* ---------- Vẽ biểu đồ (SVG) ---------- */
function lineChart(el, { times, values, nowIdx, unit = '', digits = 0, bands = null, color, kind = 'line', yMin = null, label }) {
  const W = el.clientWidth || 600, H = el.clientHeight || 200;
  const m = { l: 34, r: 10, t: 12, b: 22 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const pts = values.map((v, i) => [i, v]).filter(p => p[1] != null);
  if (!pts.length) { el.innerHTML = '<p class="hint">Không có dữ liệu.</p>'; return; }
  let lo = yMin != null ? yMin : Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1]));
  if (bands) lo = 0;
  if (hi === lo) hi = lo + 1;
  const span = hi - lo; const step = niceStep(span / 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = i => m.l + (i / Math.max(1, values.length - 1)) * iw;
  const y = v => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label || '')}">`;
  // dải màu mức AQI (rất nhạt)
  if (bands) {
    let prev = 0;
    for (const b of bands) {
      const top = Math.min(b.max, hi); if (prev >= hi) break;
      s += `<rect x="${m.l}" y="${y(top)}" width="${iw}" height="${y(prev) - y(top)}" fill="${b.color}" opacity=".13"/>`;
      prev = b.max;
    }
  }
  for (let v = lo; v <= hi + 1e-9; v += step) s += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v, step < 1 ? 1 : 0)}</text>`;
  // nhãn trục thời gian mỗi 6 giờ
  times.forEach((t, i) => { const h = +t.slice(11, 13); if (h % 6 === 0) s += `<text class="ax" x="${x(i)}" y="${H - 5}" text-anchor="middle">${h === 0 ? t.slice(8, 10) + '/' + t.slice(5, 7) : h + 'h'}</text>`; });
  const col = color || 'var(--chart-line)';
  if (kind === 'bar') {
    const bw = Math.max(2, iw / values.length - 2);
    values.forEach((v, i) => { if (v == null || v <= 0) return; const yy = y(v); s += `<rect x="${x(i) - bw / 2}" y="${yy}" width="${bw}" height="${m.t + ih - yy}" rx="${Math.min(2, bw / 2)}" fill="${col}" opacity="${i > nowIdx ? .55 : 1}"/>`; });
  } else {
    const path = (arr) => arr.map((p, j) => `${j ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const past = pts.filter(p => p[0] <= nowIdx), fut = pts.filter(p => p[0] >= nowIdx);
    if (past.length) s += `<path d="${path(past)}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (fut.length) s += `<path d="${path(fut)}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="4 3" opacity=".7"/>`;
  }
  if (nowIdx >= 0) {
    s += `<line class="now" x1="${x(nowIdx)}" x2="${x(nowIdx)}" y1="${m.t}" y2="${m.t + ih}"/>`;
    const nv = values[nowIdx];
    if (nv != null && kind !== 'bar') s += `<circle cx="${x(nowIdx)}" cy="${y(nv)}" r="5" fill="${col}" stroke="var(--surface)" stroke-width="2"/>`;
  }
  s += `<g class="hov" style="display:none"><line x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="var(--muted)" stroke-width="1"/><circle r="4.5" fill="${col}" stroke="var(--surface)" stroke-width="2"/></g>`;
  s += `<rect x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent" class="hit"/></svg><div class="tip" hidden></div>`;
  el.innerHTML = s;
  const svg = el.querySelector('svg'), hov = svg.querySelector('.hov'), tip = el.querySelector('.tip');
  const move = ev => {
    const r = svg.getBoundingClientRect(); const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
    const sx = cx * (W / r.width);
    const i = Math.max(0, Math.min(values.length - 1, Math.round(((sx - m.l) / iw) * (values.length - 1))));
    const v = values[i]; if (v == null) return;
    hov.style.display = ''; hov.querySelector('line').setAttribute('x1', x(i)); hov.querySelector('line').setAttribute('x2', x(i));
    const c = hov.querySelector('circle'); c.setAttribute('cx', x(i)); c.setAttribute('cy', y(v));
    tip.hidden = false;
    const t = times[i];
    const lvl = bands ? ` · ${aqiLevel(v).name}` : '';
    tip.innerHTML = `<b>${fmt(v, digits)}${unit ? ' ' + unit : ''}</b>${lvl}<br><span style="color:var(--muted)">${t.slice(8, 10)}/${t.slice(5, 7)} ${t.slice(11, 16)}${i > nowIdx ? ' · dự báo' : i === nowIdx ? ' · hiện tại' : ''}</span>`;
    tip.style.left = Math.max(60, Math.min(r.width - 60, x(i) * r.width / W)) + 'px';
    tip.style.top = Math.max(30, y(v) * r.height / H - 8) + 'px';
  };
  const leave = () => { hov.style.display = 'none'; tip.hidden = true; };
  svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move); svg.addEventListener('pointerleave', leave);
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/* ---------- Gauge AQI ---------- */
function drawGauge(v) {
  const cx = 120, cy = 118, R = 96, w = 16;
  const seg = AQI_LEVELS.length; const gap = 0.025;
  const arc = (a0, a1, r) => { const p = a => [cx + r * Math.cos(a), cy + r * Math.sin(a)]; const [x0, y0] = p(a0), [x1, y1] = p(a1); return `M${x0},${y0}A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`; };
  let s = '';
  const bounds = [0, 50, 100, 150, 200, 300, 500];
  for (let i = 0; i < seg; i++) {
    const a0 = Math.PI + (i / seg) * Math.PI + gap, a1 = Math.PI + ((i + 1) / seg) * Math.PI - gap;
    const active = v != null && aqiIdx(v) === i;
    s += `<path d="${arc(a0, a1, R)}" stroke="${AQI_LEVELS[i].color}" stroke-width="${active ? w + 4 : w}" fill="none" stroke-linecap="round" opacity="${v == null || active ? 1 : .35}"/>`;
  }
  [0, 2, 4, 6].forEach(i => { const a = Math.PI + (i / seg) * Math.PI; s += `<text class="gauge-tick" x="${cx + (R - 24) * Math.cos(a)}" y="${cy + (R - 24) * Math.sin(a) + 4}" text-anchor="middle">${bounds[i]}</text>`; });
  if (v != null) {
    const i = Math.min(seg - 1, aqiIdx(v)); const lo = bounds[i], hi = bounds[i + 1];
    const frac = (i + Math.min(1, (v - lo) / (hi - lo))) / seg; const a = Math.PI + frac * Math.PI;
    s += `<circle cx="${cx + R * Math.cos(a)}" cy="${cy + R * Math.sin(a)}" r="9" fill="var(--surface)" stroke="var(--ink)" stroke-width="3"/>`;
  }
  s += `<text class="gauge-num" x="${cx}" y="${cy - 14}" text-anchor="middle">${v == null ? '—' : Math.round(v)}</text><text class="gauge-lbl" x="${cx}" y="${cy + 8}" text-anchor="middle">US AQI</text>`;
  $('#gauge').innerHTML = s;
}

/* ---------- Render ---------- */
function renderAll() {
  renderLocation(); renderAir(); renderWeather(); renderChanges(); updateLiveText();
}
function renderLocation() {
  $('#locName').textContent = S.loc?.name || '—';
  $('#locSub').textContent = [S.loc?.sub, S.loc ? `${S.loc.lat.toFixed(3)}, ${S.loc.lon.toFixed(3)}` : ''].filter(Boolean).join(' · ');
  document.title = `${S.aq?.current?.us_aqi != null ? 'AQI ' + Math.round(S.aq.current.us_aqi) + ' · ' : ''}${S.loc?.name || ''} — Bầu Trời Sống`;
}

function deltaHTML(cur, old, digits = 0, { pollutant = true, unit = '', short = false } = {}) {
  if (cur == null || old == null) return '<span class="delta-flat">—</span>';
  const d = cur - old; const th = Math.pow(10, -digits) / 2;
  if (Math.abs(d) < Math.max(th, 0.05)) return `<span class="delta-flat">${short ? '=' : '= không đổi'}</span>`;
  const cls = pollutant ? (d > 0 ? 'delta-up' : 'delta-down') : 'delta-neutral';
  return `<span class="${cls}">${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d), digits)}${unit}</span>`;
}

function renderAir() {
  const aq = S.aq; if (!aq) return;
  const c = aq.current, h = aq.hourly; const i = hourIndex(h, c.time);
  const v = c.us_aqi; const L = aqiLevel(v ?? 0);
  drawGauge(v);
  $('#aqiCat').innerHTML = v == null ? '—' : `<i style="background:${L.color}"></i>${L.name}`;
  $('#aqiAdvice').textContent = v == null ? 'Chưa có dữ liệu.' : L.advice;
  $('#aqiEu').textContent = c.european_aqi != null ? Math.round(c.european_aqi) : '—';
  const main = POLLUTANTS.filter(p => p.sub && c[p.sub] != null).sort((a, b) => c[b.sub] - c[a.sub])[0];
  $('#aqiMain').textContent = main ? main.name : '—';
  $('#aqiDelta').innerHTML = `1 giờ trước: ${deltaHTML(v, valAgo(h, 'us_aqi', i, 1))} · 24 giờ trước: ${deltaHTML(v, valAgo(h, 'us_aqi', i, 24))}`;

  $('#polGrid').innerHTML = POLLUTANTS.map(p => {
    const val = c[p.k]; const sub = p.sub ? c[p.sub] : null;
    let bar = '', lvl = '';
    if (p.k === 'uv_index') {
      const uv = val ?? 0; const uvL = uv < 3 ? ['Thấp', '#22B14C'] : uv < 6 ? ['Trung bình', '#F2D00A'] : uv < 8 ? ['Cao', '#FF8A1F'] : uv < 11 ? ['Rất cao', '#E5322D'] : ['Cực độ', '#8F3F97'];
      bar = `<div class="bar"><i style="width:${Math.min(100, uv / 11 * 100)}%;background:${uvL[1]}"></i></div>`; lvl = uvL[0];
    } else if (sub != null) {
      const l = aqiLevel(sub); bar = `<div class="bar"><i style="width:${Math.min(100, Math.max(3, sub / 300 * 100))}%;background:${l.color}"></i></div>`; lvl = `${l.name} · ${Math.round(sub)}`;
    } else {
      bar = `<div class="bar"><i style="width:${Math.min(100, (val ?? 0) / 200 * 100)}%;background:var(--muted)"></i></div>`; lvl = '';
    }
    const d1 = h[p.k] ? deltaHTML(val, valAgo(h, p.k, i, 1), p.d) : '';
    return `<div class="pol"><div class="pol-top"><span class="pol-name">${p.name}</span><span class="pol-full">${p.full}</span></div>
      <div class="pol-val">${fmt(val, p.d)}<small>${p.unit}</small></div>${bar}
      <div class="pol-foot"><span>${lvl}</span><span title="so với 1 giờ trước">${d1}</span></div></div>`;
  }).join('');
  renderAqChart();
}
function renderAqChart() {
  const aq = S.aq; if (!aq) return;
  const h = aq.hourly, i = hourIndex(h, aq.current.time), m = S.aqMetric;
  const from = Math.max(0, i - 24), to = Math.min(h.time.length, i + 25);
  const units = { us_aqi: '', pm2_5: 'µg/m³', pm10: 'µg/m³', ozone: 'µg/m³', nitrogen_dioxide: 'µg/m³' };
  lineChart($('#aqChart'), {
    times: h.time.slice(from, to), values: h[m].slice(from, to), nowIdx: i - from, unit: units[m], digits: m === 'us_aqi' ? 0 : 1,
    bands: m === 'us_aqi' ? AQI_LEVELS : null, yMin: 0, label: 'Diễn biến ' + m,
  });
}

function renderWeather() {
  const wx = S.wx; if (!wx) return;
  const c = wx.current, h = wx.hourly, d = wx.daily; const i = hourIndex(h, c.time);
  $('#wxIcon').innerHTML = wxIcon(c.weather_code, c.is_day);
  $('#wxTemp').textContent = `${fmt(c.temperature_2m, 1)}°`;
  $('#wxDesc').textContent = WMO[c.weather_code] || '—';
  $('#wxFeel').innerHTML = `Cảm giác như ${fmt(c.apparent_temperature, 0)}° · Cao ${fmt(d.temperature_2m_max[1], 0)}° / Thấp ${fmt(d.temperature_2m_min[1], 0)}° · 1 giờ trước: ${deltaHTML(c.temperature_2m, valAgo(h, 'temperature_2m', i, 1), 1, { pollutant: false, unit: '°' })}`;
  // d[0] là hôm qua (past_days=1)
  const stats = [
    ['Độ ẩm', `${fmt(c.relative_humidity_2m)}%`],
    ['Gió', `${fmt(c.wind_speed_10m)} km/h ${dirName(c.wind_direction_10m, true)}`],
    ['Gió giật', `${fmt(c.wind_gusts_10m)} km/h`],
    ['Lượng mưa', `${fmt(c.precipitation, 1)} mm`],
    ['Mây che phủ', `${fmt(c.cloud_cover)}%`],
    ['Áp suất', `${fmt(c.pressure_msl)} hPa`],
    ['Điểm sương', `${fmt(h.dew_point_2m?.[i], 1)}°`],
    ['Tầm nhìn', h.visibility?.[i] != null ? `${fmt(h.visibility[i] / 1000, 1)} km` : '—'],
    ['Chỉ số UV', fmt(h.uv_index?.[i], 1)],
    ['Bình minh', tLabel(d.sunrise[1])],
    ['Hoàng hôn', tLabel(d.sunset[1])],
  ];
  $('#wxStats').innerHTML = stats.map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');

  const from = Math.max(0, i - 6), to = Math.min(h.time.length, i + 42);
  lineChart($('#tempChart'), { times: h.time.slice(from, to), values: h.temperature_2m.slice(from, to), nowIdx: i - from, unit: '°C', digits: 1, color: '#E8762C', label: 'Nhiệt độ' });
  lineChart($('#rainChart'), { times: h.time.slice(from, to), values: h.precipitation_probability.slice(from, to), nowIdx: i - from, unit: '%', kind: 'bar', yMin: 0, label: 'Khả năng mưa' });

  let strip = '';
  for (let k = i; k < Math.min(h.time.length, i + 25); k++) {
    const pp = h.precipitation_probability[k];
    strip += `<div class="hour${k === i ? ' now' : ''}"><div>${k === i ? 'Bây giờ' : tLabel(h.time[k])}</div>${wxIcon(h.weather_code[k], h.is_day[k])}<b>${fmt(h.temperature_2m[k])}°</b><div class="pp">${pp >= 10 ? '💧' + pp + '%' : ''}</div></div>`;
  }
  $('#hourStrip').innerHTML = strip;

  const tmin = Math.min(...d.temperature_2m_min.slice(1)), tmax = Math.max(...d.temperature_2m_max.slice(1));
  $('#dailyList').innerHTML = d.time.slice(1).map((t, j) => {
    const k = j + 1; const lo = d.temperature_2m_min[k], hi = d.temperature_2m_max[k];
    const l = (lo - tmin) / (tmax - tmin || 1) * 100, r = (hi - tmin) / (tmax - tmin || 1) * 100;
    return `<div class="day"><div class="dd"><b>${dayLabel(t, j)}</b><small>${t.slice(8, 10)}/${t.slice(5, 7)}</small></div>${wxIcon(d.weather_code[k], 1)}
      <div class="trange"><span>${fmt(lo)}°</span><div class="rb"><i style="left:${l}%;right:${100 - r}%"></i></div><span>${fmt(hi)}°</span></div>
      <div class="rain">${WMO[d.weather_code[k]] || ''}<br>${d.precipitation_probability_max[k] != null ? '💧' + d.precipitation_probability_max[k] + '% · ' : ''}${fmt(d.precipitation_sum[k], 1)} mm</div></div>`;
  }).join('');
}

function renderChanges() {
  if (!S.aq || !S.wx) return;
  const a = S.aq, w = S.wx, ai = hourIndex(a.hourly, a.current.time), wi = hourIndex(w.hourly, w.current.time);
  const rows = [
    ['AQI (US)', a.current.us_aqi, a.hourly, 'us_aqi', ai, 0, true, ''],
    ['PM2.5', a.current.pm2_5, a.hourly, 'pm2_5', ai, 1, true, ' µg/m³'],
    ['PM10', a.current.pm10, a.hourly, 'pm10', ai, 0, true, ' µg/m³'],
    ['O₃', a.current.ozone, a.hourly, 'ozone', ai, 0, true, ' µg/m³'],
    ['NO₂', a.current.nitrogen_dioxide, a.hourly, 'nitrogen_dioxide', ai, 1, true, ' µg/m³'],
    ['Nhiệt độ', w.current.temperature_2m, w.hourly, 'temperature_2m', wi, 1, false, '°C'],
    ['Độ ẩm', w.current.relative_humidity_2m, w.hourly, 'relative_humidity_2m', wi, 0, false, '%'],
    ['Gió', w.current.wind_speed_10m, w.hourly, 'wind_speed_10m', wi, 0, false, ' km/h'],
    ['Áp suất', w.current.pressure_msl, w.hourly, 'pressure_msl', wi, 0, false, ' hPa'],
  ];
  $('#cmpTable').innerHTML = `<thead><tr><th>Chỉ số</th><th>Hiện tại</th><th>1 giờ</th><th>3 giờ</th><th>24 giờ</th></tr></thead><tbody>` +
    rows.map(([n, cur, h, k, i, dg, pol, u]) => `<tr><td>${n}</td><td><b>${fmt(cur, dg)}</b><small class="u">${u}</small></td>${[1, 3, 24].map(x => `<td>${deltaHTML(cur, valAgo(h, k, i, x), dg, { pollutant: pol, short: true })}</td>`).join('')}</tr>`).join('') + '</tbody>';

  const ev = S.events;
  $('#eventList').innerHTML = ev.length ? ev.slice(0, 80).map(e => {
    const d = new Date(e.t);
    return `<li><span class="ev-ic">${esc(e.icon)}</span><span>${esc(e.text)}</span><small>${esc(e.place)} · ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hhmm(d)}</small></li>`;
  }).join('') : '<li><span class="empty">Chưa ghi nhận thay đổi nào. Để app mở (hoặc quay lại sau), mỗi lần số liệu mới về sẽ được so sánh và ghi vào đây.</span></li>';

  const hist = store.get('bt-hist-' + locKey(S.loc), []);
  $('#logTable').innerHTML = `<thead><tr><th>Lúc tải</th><th>Số liệu</th><th>AQI</th><th>PM2.5</th><th>Nhiệt</th><th>Ẩm</th><th>Gió</th><th>Thời tiết</th></tr></thead><tbody>` +
    (hist.slice(-30).reverse().map(r => { const d = new Date(r.t); return `<tr><td>${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hhmm(d)}</td><td>${tLabel(r.wxT)}</td><td>${fmt(r.aqi)}</td><td>${fmt(r.pm25, 1)}</td><td>${fmt(r.temp, 1)}°</td><td>${fmt(r.hum)}%</td><td>${fmt(r.wind)}</td><td>${esc(WMO[r.code] || '')}</td></tr>`; }).join('') || '<tr><td colspan="8">Chưa có.</td></tr>') + '</tbody>';
}

/* ---------- Bản đồ ---------- */
S.mapLayer = 'aqi';
function initMap() {
  if (S.map) { S.map.invalidateSize(); return; }
  const map = S.map = L.map('map', { zoomControl: true, attributionControl: true }).setView([S.loc.lat, S.loc.lon], 9);
  S.base = L.tileLayer(baseUrl(), { maxZoom: 19, subdomains: 'abcd', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a> · Open-Meteo' }).addTo(map);
  S.markers = L.layerGroup().addTo(map);
  S.me = L.marker([S.loc.lat, S.loc.lon], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }), zIndexOffset: 1000 }).addTo(map);
  let t; map.on('moveend', () => { clearTimeout(t); t = setTimeout(refreshMapData, 400); });
  map.on('click', e => mapPopup(e.latlng));
  setupRadar();
  refreshMapData();
}
function baseUrl() {
  const dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  return `https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`;
}
const mapCache = new Map();
async function refreshMapData() {
  const map = S.map; if (!map) return;
  S.me.setLatLng([S.loc.lat, S.loc.lon]);
  renderLegend();
  if (S.mapLayer === 'none') { S.markers.clearLayers(); $('#mapStatus').textContent = ''; return; }
  const b = map.getBounds(); const size = map.getSize();
  const cols = Math.max(3, Math.min(8, Math.round(size.x / 110))), rows = Math.max(3, Math.min(8, Math.round(size.y / 90)));
  const pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const lat = b.getSouth() + (b.getNorth() - b.getSouth()) * (r + .5) / rows;
    const lon = b.getWest() + (b.getEast() - b.getWest()) * (c + .5) / cols;
    if (lat > -85 && lat < 85) pts.push([+lat.toFixed(3), +(((lon + 540) % 360) - 180).toFixed(3)]);
  }
  const isAir = S.mapLayer === 'aqi' || S.mapLayer === 'pm25';
  const key = (isAir ? 'a' : 'w') + pts.map(p => p.join(',')).join(';') + '|' + Math.floor(Date.now() / REFRESH_MS);
  $('#mapStatus').textContent = 'Đang tải số liệu khu vực…';
  try {
    let data = mapCache.get(key);
    if (!data) {
      const q = `latitude=${pts.map(p => p[0]).join(',')}&longitude=${pts.map(p => p[1]).join(',')}`;
      data = await getJSON(isAir ? `${API.aq}?${q}&current=us_aqi,pm2_5` : `${API.wx}?${q}&current=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code&wind_speed_unit=kmh`);
      if (!Array.isArray(data)) data = [data];
      mapCache.set(key, data); if (mapCache.size > 40) mapCache.delete(mapCache.keys().next().value);
    }
    S.markers.clearLayers();
    data.forEach((d, j) => {
      const c = d.current || {}; const [lat, lon] = pts[j];
      let html, size = [38, 24];
      if (S.mapLayer === 'aqi' && c.us_aqi != null) { const l = aqiLevel(c.us_aqi); html = `<div class="mk" style="background:${l.color};color:${l.ink}">${Math.round(c.us_aqi)}</div>`; }
      else if (S.mapLayer === 'pm25' && c.pm2_5 != null) { const l = aqiLevel(pm25ToAqi(c.pm2_5)); html = `<div class="mk" style="background:${l.color};color:${l.ink}">${fmt(c.pm2_5)}</div>`; }
      else if (S.mapLayer === 'temp' && c.temperature_2m != null) { const [bg, ink] = tempColor(c.temperature_2m); html = `<div class="mk" style="background:${bg};color:${ink}">${fmt(c.temperature_2m)}°</div>`; }
      else if (S.mapLayer === 'wind' && c.wind_speed_10m != null) {
        size = [40, 40];
        html = `<div class="mk-wind" style="position:relative"><svg viewBox="0 0 40 40" width="40" height="40" style="transform:rotate(${c.wind_direction_10m + 180}deg)"><path d="M20 4l7 14h-5v16h-4V18h-5z" fill="${windColor(c.wind_speed_10m)}" stroke="#fff" stroke-width="1.2"/></svg><small>${fmt(c.wind_speed_10m)}</small></div>`;
      } else return;
      const mk = L.marker([lat, lon], { icon: L.divIcon({ className: '', html, iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2] }) });
      mk.on('click', () => mapPopup(L.latLng(lat, lon)));
      S.markers.addLayer(mk);
    });
    $('#mapStatus').textContent = `${data.length} điểm lấy mẫu · cập nhật ${hhmm(new Date())} · chạm vào bản đồ để xem chi tiết`;
  } catch (e) {
    console.warn(e); $('#mapStatus').textContent = 'Không tải được số liệu bản đồ.';
  }
}
function pm25ToAqi(c) { // EPA 2024
  const bp = [[0, 9, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150], [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 500, 301, 500]];
  const b = bp.find(x => c <= x[1]) || bp[5]; return (b[3] - b[2]) / (b[1] - b[0]) * (c - b[0]) + b[2];
}
function tempColor(t) {
  const stops = [[0, '#2C5DB8'], [10, '#3E8FD6'], [18, '#7FC0E0'], [24, '#E9E3B4'], [29, '#F2A33A'], [34, '#E2552B'], [40, '#9E1F2E']];
  let c = stops[stops.length - 1][1];
  for (let i = 0; i < stops.length; i++) if (t <= stops[i][0]) { c = stops[i][1]; break; }
  const dark = ['#2C5DB8', '#3E8FD6', '#E2552B', '#9E1F2E'].includes(c);
  return [c, dark ? '#fff' : '#1B1B1B'];
}
const windColor = v => v < 10 ? '#3E8FD6' : v < 20 ? '#22A06B' : v < 35 ? '#E8A317' : v < 50 ? '#E2552B' : '#9E1F2E';
function renderLegend() {
  const el = $('#mapLegend'); const l = S.mapLayer;
  if (l === 'aqi' || l === 'pm25') el.innerHTML = AQI_LEVELS.map((x, i) => `<span><i style="background:${x.color}"></i>${x.name}${l === 'pm25' ? ` (${['≤9', '≤35', '≤55', '≤125', '≤225', '>225'][i]})` : ` (${['0–50', '51–100', '101–150', '151–200', '201–300', '300+'][i]})`}</span>`).join('') + (l === 'pm25' ? '<span>µg/m³</span>' : '');
  else if (l === 'temp') el.innerHTML = [['≤0°', '#2C5DB8'], ['10°', '#3E8FD6'], ['18°', '#7FC0E0'], ['24°', '#E9E3B4'], ['29°', '#F2A33A'], ['34°', '#E2552B'], ['40°+', '#9E1F2E']].map(([t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('');
  else if (l === 'wind') el.innerHTML = [['<10', '#3E8FD6'], ['10–20', '#22A06B'], ['20–35', '#E8A317'], ['35–50', '#E2552B'], ['>50 km/h', '#9E1F2E']].map(([t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('') + '<span>Mũi tên = hướng gió thổi tới</span>';
  else el.innerHTML = '';
  if ($('#radarToggle').checked) el.innerHTML += '<span><i style="background:linear-gradient(90deg,#9FD8F5,#2C6FD6,#F2D00A,#E5322D)"></i>Radar mưa (nhẹ → to)</span>';
}
async function mapPopup(ll) {
  const pop = L.popup().setLatLng(ll).setContent('Đang tải…').openOn(S.map);
  try {
    const q = `latitude=${ll.lat.toFixed(3)}&longitude=${ll.lng.toFixed(3)}&timezone=auto`;
    const [a, w, name] = await Promise.all([
      getJSON(`${API.aq}?${q}&current=us_aqi,pm2_5,pm10`),
      getJSON(`${API.wx}?${q}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,precipitation&wind_speed_unit=kmh`),
      reverseName(ll.lat, ll.lng).catch(() => null),
    ]);
    const ac = a.current, wc = w.current, l = aqiLevel(ac.us_aqi ?? 0);
    const nm = name?.name || `${ll.lat.toFixed(3)}, ${ll.lng.toFixed(3)}`;
    pop.setContent(`<b>${esc(nm)}</b><br>
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${l.color}"></span> AQI <b>${fmt(ac.us_aqi)}</b> · ${l.name}<br>
      PM2.5 ${fmt(ac.pm2_5, 1)} · PM10 ${fmt(ac.pm10)} µg/m³<br>
      ${fmt(wc.temperature_2m, 1)}°C · ${esc(WMO[wc.weather_code] || '')} · ẩm ${fmt(wc.relative_humidity_2m)}%<br>
      Gió ${fmt(wc.wind_speed_10m)} km/h ${dirName(wc.wind_direction_10m, true)} · mưa ${fmt(wc.precipitation, 1)} mm<br>
      <button class="pop-btn" id="popGo">Xem chi tiết tại đây</button>`);
    setTimeout(() => { const b = $('#popGo'); if (b) b.onclick = () => { S.map.closePopup(); setLocation({ lat: ll.lat, lon: ll.lng, name: name?.name || 'Điểm đã chọn', sub: name?.sub || '' }); go('air'); }; });
  } catch { pop.setContent('Không tải được dữ liệu điểm này.'); }
}

/* Radar mưa RainViewer */
async function setupRadar() {
  try {
    const d = await getJSON(API.radar);
    const frames = [...(d.radar?.past || []), ...(d.radar?.nowcast || [])];
    if (!frames.length) return;
    S.radar = { host: d.host, frames, nPast: d.radar.past.length, layers: {}, idx: d.radar.past.length - 1, timer: null, fetched: Date.now() };
    const sl = $('#radarSlider'); sl.max = frames.length - 1; sl.value = S.radar.idx;
    sl.oninput = () => showRadar(+sl.value);
    $('#radarPlay').onclick = toggleRadarPlay;
    applyRadarToggle();
  } catch (e) { console.warn('radar', e); $('#radarToggle').closest('label').title = 'Radar không khả dụng'; }
}
function radarLayer(i) {
  const R = S.radar; if (R.layers[i]) return R.layers[i];
  const f = R.frames[i];
  return R.layers[i] = L.tileLayer(`${R.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0, zIndex: 400, maxNativeZoom: 7, maxZoom: 19, tileSize: 256, attribution: 'RainViewer' });
}
function showRadar(i) {
  const R = S.radar; if (!R || !S.map) return;
  const on = $('#radarToggle').checked;
  const next = radarLayer(i); if (!S.map.hasLayer(next)) next.addTo(S.map);
  next.setOpacity(on ? .7 : 0);
  if (R.cur != null && R.cur !== i && R.layers[R.cur]) R.layers[R.cur].setOpacity(0);
  R.cur = i; R.idx = i;
  // tải trước khung kế tiếp cho mượt
  const n = (i + 1) % R.frames.length; const pre = radarLayer(n); if (!S.map.hasLayer(pre)) pre.addTo(S.map);
  const t = new Date(R.frames[i].time * 1000);
  $('#radarTime').textContent = `${hhmm(t)}${i >= R.nPast ? ' (dự báo)' : i === R.nPast - 1 ? ' (mới nhất)' : ''}`;
  $('#radarSlider').value = i;
}
function toggleRadarPlay() {
  const R = S.radar; if (!R) return;
  if (R.timer) { clearInterval(R.timer); R.timer = null; $('#radarPlay').textContent = '▶'; return; }
  $('#radarPlay').textContent = '⏸';
  R.timer = setInterval(() => showRadar((R.idx + 1) % R.frames.length), 700);
}
function applyRadarToggle() {
  const on = $('#radarToggle').checked; $('#radarBar').hidden = !on || !S.radar;
  if (!S.radar) return;
  if (!on) { Object.values(S.radar.layers).forEach(l => l.setOpacity(0)); if (S.radar.timer) toggleRadarPlay(); }
  else showRadar(S.radar.idx);
  renderLegend();
}
async function refreshRadar() { // khung mới mỗi ~10 phút
  if (!S.radar || Date.now() - S.radar.fetched < 9 * 60000) return;
  const playing = !!S.radar.timer; if (playing) toggleRadarPlay();
  Object.values(S.radar.layers).forEach(l => S.map.removeLayer(l));
  S.radar = null; await setupRadar(); if (playing) toggleRadarPlay();
}

/* ---------- Địa điểm ---------- */
async function reverseName(lat, lon) {
  const r = await getJSON(`${API.rev}?latitude=${lat}&longitude=${lon}&localityLanguage=vi`, 8000);
  const name = r.locality || r.city || r.principalSubdivision || r.countryName;
  const sub = [r.city && r.city !== name ? r.city : null, r.principalSubdivision !== name ? r.principalSubdivision : null, r.countryName].filter(Boolean).join(', ');
  return { name, sub };
}
function setLocation(loc) {
  S.loc = { lat: +loc.lat, lon: +loc.lon, name: loc.name || 'Vị trí', sub: loc.sub || '' };
  store.set('bt-loc', S.loc);
  S.aq = null; S.wx = null;
  renderLocation(); renderFavs();
  if (S.map) S.map.setView([S.loc.lat, S.loc.lon], Math.max(S.map.getZoom(), 9));
  loadAll();
}
function useGPS(quiet) {
  if (!('geolocation' in navigator)) { if (!quiet) toast('Thiết bị không hỗ trợ định vị.'); return Promise.resolve(false); }
  if (!quiet) toast('Đang lấy vị trí…');
  return new Promise(res => navigator.geolocation.getCurrentPosition(async p => {
    const { latitude: lat, longitude: lon } = p.coords;
    let n = { name: 'Vị trí của tôi', sub: '' };
    try { n = await reverseName(lat, lon); } catch {}
    setLocation({ lat, lon, name: n.name || 'Vị trí của tôi', sub: n.sub });
    res(true);
  }, err => { if (!quiet) toast(err.code === 1 ? 'Bạn đã chặn quyền vị trí. Hãy tìm địa điểm bằng tay.' : 'Không lấy được vị trí.'); res(false); },
  { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }));
}
let searchT;
async function doSearch(qs) {
  const box = $('#searchResults');
  if (qs.trim().length < 2) { box.innerHTML = ''; return; }
  box.innerHTML = '<p class="hint">Đang tìm…</p>';
  try {
    const r = await getJSON(`${API.geo}?name=${encodeURIComponent(qs.trim())}&count=10&language=vi&format=json`);
    const res = r.results || [];
    box.innerHTML = res.length ? res.map((x, i) => `<div class="item"><button class="pick" data-i="${i}"><b>${esc(x.name)}</b><small>${esc([x.admin2, x.admin1, x.country].filter(Boolean).join(', '))}</small></button></div>`).join('') : '<p class="hint">Không tìm thấy. Thử tên khác (ví dụ: “Đà Nẵng”, “Thu Duc”).</p>';
    $$('.pick', box).forEach(b => b.onclick = () => { const x = res[+b.dataset.i]; closeSheet(); setLocation({ lat: x.latitude, lon: x.longitude, name: x.name, sub: [x.admin1, x.country].filter(Boolean).join(', ') }); });
  } catch { box.innerHTML = '<p class="hint">Lỗi kết nối khi tìm kiếm.</p>'; }
}
function renderFavs() {
  const isFav = S.favs.some(f => locKey(f) === locKey(S.loc || DEFAULT_LOC));
  const cur = S.loc ? `<div class="item"><span><b>${esc(S.loc.name)}</b><small>Đang xem</small></span><button class="star" id="favToggle" aria-label="Lưu">${isFav ? '★' : '☆'}</button></div>` : '';
  $('#favList').innerHTML = cur + S.favs.filter(f => !S.loc || locKey(f) !== locKey(S.loc)).map(f => `<div class="item"><button class="pick" data-k="${locKey(f)}"><b>${esc(f.name)}</b><small>${esc(f.sub || '')}</small></button><button class="star" data-del="${locKey(f)}" aria-label="Bỏ lưu">★</button></div>`).join('');
  const ft = $('#favToggle'); if (ft) ft.onclick = () => {
    if (isFav) S.favs = S.favs.filter(f => locKey(f) !== locKey(S.loc)); else S.favs.push({ ...S.loc });
    store.set('bt-favs', S.favs); renderFavs();
  };
  $$('#favList [data-k]').forEach(b => b.onclick = () => { closeSheet(); setLocation(S.favs.find(f => locKey(f) === b.dataset.k)); });
  $$('#favList [data-del]').forEach(b => b.onclick = () => { S.favs = S.favs.filter(f => locKey(f) !== b.dataset.del); store.set('bt-favs', S.favs); renderFavs(); });
}
function openSheet() { $('#sheet').hidden = false; renderFavs(); setTimeout(() => $('#searchInput').focus(), 50); }
function closeSheet() { $('#sheet').hidden = true; $('#searchInput').value = ''; $('#searchResults').innerHTML = ''; }

/* ---------- Điều hướng & sự kiện ---------- */
function go(tab) {
  S.tab = tab; store.set('bt-tab', tab);
  $$('.tab').forEach(s => s.hidden = s.dataset.tab !== tab);
  $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.go === tab));
  if (tab === 'map') initMap();
  if (tab === 'air') renderAqChart();
  if (tab === 'weather' && S.wx) renderWeather();
  if (tab === 'changes') renderChanges();
  window.scrollTo(0, 0);
}
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  if (S.base) S.base.setUrl(baseUrl());
}

function bind() {
  $$('#tabbar button').forEach(b => b.onclick = () => go(b.dataset.go));
  $('#locBtn').onclick = openSheet;
  $('#sheetClose').onclick = closeSheet;
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };
  $('#sheetGps').onclick = () => { closeSheet(); useGPS(); };
  $('#gpsBtn').onclick = () => useGPS();
  $('#refreshBtn').onclick = () => { loadAll(); if (S.map) refreshRadar(); };
  $('#searchInput').oninput = e => { clearTimeout(searchT); searchT = setTimeout(() => doSearch(e.target.value), 350); };
  $('#themeBtn').onclick = () => {
    const curDark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const t = curDark ? 'light' : 'dark'; store.set('bt-theme', t); applyTheme(t);
    renderAll();
  };
  $$('#aqMetricSeg button').forEach(b => b.onclick = () => { $$('#aqMetricSeg button').forEach(x => x.classList.toggle('on', x === b)); S.aqMetric = b.dataset.m; renderAqChart(); });
  $$('#mapLayerSeg button').forEach(b => b.onclick = () => { $$('#mapLayerSeg button').forEach(x => x.classList.toggle('on', x === b)); S.mapLayer = b.dataset.l; refreshMapData(); });
  $('#radarToggle').onchange = applyRadarToggle;
  $('#notifyBtn').onclick = async () => {
    if (!('Notification' in window)) return toast('Trình duyệt không hỗ trợ thông báo.');
    const on = store.get('bt-notify', false);
    if (on) { store.set('bt-notify', false); updateNotifyBtn(); return toast('Đã tắt thông báo.'); }
    const p = await Notification.requestPermission();
    if (p === 'granted') { store.set('bt-notify', true); toast('Sẽ báo khi có thay đổi đáng kể (khi app đang mở nền).'); }
    else toast('Chưa được cấp quyền thông báo.');
    updateNotifyBtn();
  };
  $('#csvBtn').onclick = () => {
    const hist = store.get('bt-hist-' + locKey(S.loc), []);
    const head = 'thoi_gian_tai,gio_so_lieu,aqi,pm2_5,pm10,o3,no2,nhiet_do,do_am,gio_kmh,gio_giat,mua_mm,ap_suat,may,thoi_tiet';
    const lines = hist.map(r => [new Date(r.t).toISOString(), r.wxT, r.aqi, r.pm25, r.pm10, r.o3, r.no2, r.temp, r.hum, r.wind, r.gust, r.rain, r.pres, r.cloud, `"${WMO[r.code] || ''}"`].join(','));
    const blob = new Blob(['﻿' + [head, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `bau-troi-${S.loc.name}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  window.addEventListener('resize', () => { clearTimeout(bind._r); bind._r = setTimeout(() => { if (S.tab === 'air') renderAqChart(); if (S.tab === 'weather') renderWeather(); }, 200); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - S.lastOk > 2 * 60000) loadAll({ silent: true }); });
  window.addEventListener('online', () => { toast('Đã có mạng lại.'); loadAll({ silent: true }); });
  window.addEventListener('offline', () => setLive('err'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
}
function updateNotifyBtn() { $('#notifyBtn').textContent = store.get('bt-notify', false) ? '🔕 Tắt thông báo' : '🔔 Bật thông báo'; }

/* ---------- Khởi động ---------- */
(async function start() {
  const th = store.get('bt-theme', null); if (th) applyTheme(th);
  bind(); updateNotifyBtn();
  setInterval(() => {
    updateLiveText();
    if (S.nextAt && Date.now() >= S.nextAt && !document.hidden) { loadAll({ silent: true }); if (S.map) refreshRadar(); }
  }, 1000);
  if (S.loc) { renderLocation(); loadAll(); }
  else {
    S.loc = { ...DEFAULT_LOC }; renderLocation();
    const ok = await useGPS(true);
    if (!ok) loadAll();
  }
  const tab = store.get('bt-tab', 'air'); go(['air', 'weather', 'map', 'changes'].includes(tab) ? tab : 'air');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
