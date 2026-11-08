// Загрузка и разбор страницы заезда timing.batyrshin.name.
import { parseLapTime } from './laps.js?v=dev';

export const HEAT_RE = /^https?:\/\/timing\.batyrshin\.name\/tracks\/([a-z0-9_-]+)\/heats\/(\d+)/i;

// Приводит ссылку к виду https://timing.batyrshin.name/tracks/<трасса>/heats/<номер>.
export function normalizeHeatUrl(s) {
  const m = String(s || '').trim().match(HEAT_RE);
  return m ? 'https://timing.batyrshin.name/tracks/' + m[1].toLowerCase() + '/heats/' + m[2] : '';
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, '0');
const clean = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

async function withTimeout(promise, ms, ctrl) {
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await promise; } finally { clearTimeout(timer); }
}

// Страницу пробуем взять напрямую (если сайт разрешит), потом через скрипт таблицы команды.
export async function fetchHeatHtml(url, apiUrl) {
  const errors = [];
  try {
    const ctrl = new AbortController();
    const r = await withTimeout(fetch(url, { signal: ctrl.signal, credentials: 'omit' }), 7000, ctrl);
    if (r.ok) {
      const html = await r.text();
      if (html.indexOf('heat-result') >= 0) return html;
    }
    errors.push('direct_' + r.status);
  } catch (e) {
    errors.push('direct');
  }
  if (apiUrl) {
    try {
      const ctrl = new AbortController();
      const r = await withTimeout(fetch(apiUrl + '?timing=' + encodeURIComponent(url), { signal: ctrl.signal }), 30000, ctrl);
      const data = await r.json();
      if (data && data.html) return data.html;
      errors.push('proxy_' + ((data && data.error) || r.status));
    } catch (e) {
      errors.push('proxy');
    }
  }
  const err = new Error('Не получилось загрузить заезд');
  err.details = errors;
  throw err;
}

// Таблица heat-result: столбцы — пилоты в порядке финиша, строки — круги.
// В каждой ячейке время круга, позиция после круга (span.p) и отрывы.
export function parseHeat(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const og = doc.querySelector('meta[property="og:image"]');
  const src = url || (og ? og.getAttribute('content') : '') || '';
  const m = String(src).match(/\/tracks\/([^/]+)\/heats\/(\d+)/) || [];
  const h = { url: m[2] ? 'https://timing.batyrshin.name/tracks/' + m[1] + '/heats/' + m[2] : src, track: m[1] || '', id: m[2] || '',
    name: clean(doc.querySelector('title')), date: '', time: '', drivers: [] };
  const when = clean(doc.querySelector('h4 small')).match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/);
  if (when && MON[when[2].toLowerCase()]) {
    h.date = when[3] + '-' + pad2(MON[when[2].toLowerCase()]) + '-' + pad2(when[1]);
    h.time = pad2(when[4]) + ':' + when[5];
  }
  const table = doc.querySelector('table.heat-result');
  if (!table) return h;
  const rowBy = (label) => Array.prototype.find.call(table.querySelectorAll('tr'), (tr) => clean(tr.querySelector('th')) === label);
  const cells = (tr) => (tr ? Array.prototype.slice.call(tr.children, 1) : []);
  const names = cells(rowBy('Driver'));
  const karts = cells(rowBy('Kart'));
  const foot = (label) => cells(rowBy(label)).map((c) => clean(c));
  const best = foot('Best');
  const avg = foot('Avg');
  names.forEach((th, i) => {
    h.drivers.push({
      name: clean(th),
      kart: clean(karts[i]),
      pos: i + 1,
      best: parseLapTime(best[i]),
      avg: parseLapTime(avg[i]),
      laps: [],
    });
  });
  table.querySelectorAll('tbody tr').forEach((tr) => {
    cells(tr).forEach((td, i) => {
      const d = h.drivers[i];
      if (!d) return;
      // Время круга — текст самой ячейки, без вложенных позиций и отрывов.
      const own = Array.prototype.filter.call(td.childNodes, (n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim();
      let t = parseLapTime(own.split(/\s+/)[0]);
      // Круг с пит-стопом сайт оборачивает во вложенный элемент — тогда берём первое число ячейки.
      if (!isFinite(t)) t = parseLapTime(clean(td).split(' ')[0]);
      if (!isFinite(t)) return;
      const p = clean(td.querySelector('.p')).match(/P(\d+)/i);
      d.laps.push({ t, pos: p ? Number(p[1]) : null, pit: /pitstop/i.test(td.className + ' ' + td.innerHTML) });
    });
  });
  h.drivers.forEach((d) => {
    if (!isFinite(d.best) && d.laps.length) d.best = Math.min.apply(null, d.laps.map((l) => l.t));
  });
  // Лучший круг всего заезда — для подписи «бест заезда».
  h.best = h.drivers.reduce((a, d) => (isFinite(d.best) && (!a || d.best < a.t) ? { t: d.best, name: d.name } : a), null);
  return h;
}
