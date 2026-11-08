// Круги и метки на видео. Чистая логика без браузера — её проверяют тесты (test/telemetry.test.js).
//
// laps    — круги пилота: [{ t: время круга в секундах, on: учитывать ли круг в лучшем }]
// markers — моменты видео (секунды), где пилот пересекает линию: markers[i] — начало круга i,
//           markers[laps.length] — финиш последнего круга. Всего меток на одну больше, чем кругов.

// «37.322», «1:09.311», «37,322» → секунды. Пустое или непонятное → NaN.
export function parseLapTime(str) {
  const m = String(str == null ? '' : str).trim().replace(',', '.').match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : NaN;
}

// Секунды → «37.322» или «1:09.311». digits — знаков после точки.
export function fmtLap(s, digits = 3) {
  if (s == null || !isFinite(s)) return '—';
  const neg = s < 0;
  const p = Math.pow(10, digits);
  // Отбрасываем, а не округляем: бегущий таймер не должен показывать время раньше, чем оно наступило.
  let v = Math.floor(Math.abs(s) * p + 1e-6) / p;
  const m = Math.floor(v / 60);
  const sec = v - m * 60;
  let out = digits ? sec.toFixed(digits) : String(Math.floor(sec));
  if (m) out = m + ':' + out.padStart(digits ? digits + 3 : 2, '0');
  return (neg ? '−' : '') + out;
}

// Разница с лучшим: «+0.412», «−0.120», «0.000».
export function fmtDelta(d, digits = 3) {
  if (d == null || !isFinite(d)) return '';
  if (Math.abs(d) < 0.5 / Math.pow(10, digits)) return (0).toFixed(digits);
  return (d > 0 ? '+' : '−') + Math.abs(d).toFixed(digits);
}

// Время видео → «мм:сс.ссс» (или «ч:мм:сс.ссс»).
export function fmtClock(s, digits = 3) {
  if (s == null || !isFinite(s)) return '—';
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(digits).padStart(digits ? digits + 3 : 2, '0');
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + sec;
}

export const totalTime = (laps) => laps.reduce((a, l) => a + (isFinite(l.t) ? l.t : 0), 0);

// Расставляет метки между началом первого круга и финишем последнего пропорционально времени кругов.
// Если конец не задан — ставит его по сумме кругов (как будто видео идёт с той же скоростью, что и хронометраж).
export function fitMarkers(laps, start, end) {
  if (!laps.length || !isFinite(start)) return [];
  const total = totalTime(laps);
  if (!(total > 0)) return [];
  if (!isFinite(end) || end <= start) end = start + total;
  const k = (end - start) / total;
  const out = [start];
  let acc = 0;
  laps.forEach((l, i) => {
    acc += isFinite(l.t) ? l.t : 0;
    out.push(i === laps.length - 1 ? end : start + acc * k);
  });
  return out;
}

// Насколько отрезок на видео длиннее суммы кругов: 1.004 — видео на 0.4% «медленнее» хронометража.
export function fitRatio(laps, markers) {
  const total = totalTime(laps);
  if (!(total > 0) || markers.length !== laps.length + 1) return NaN;
  return (markers[markers.length - 1] - markers[0]) / total;
}

// Лучший круг среди первых n кругов (только учитываемые). → { t, i } или null.
export function bestOf(laps, n = laps.length) {
  let best = null;
  for (let i = 0; i < Math.min(n, laps.length); i++) {
    const l = laps[i];
    if (l.on === false || !isFinite(l.t)) continue;
    if (!best || l.t < best.t) best = { t: l.t, i };
  }
  return best;
}

// Что показывать в момент видео t.
// phase: 'none' (меток нет), 'pre' (до старта), 'lap' (идёт круг lap), 'done' (после финиша).
// current — бегущее время круга. Оно растягивается по длине круга на видео так, что ровно
// на следующей метке показывает официальное время круга.
// final: true — «лучший» сразу итоговый за весь заезд, а не на текущий момент.
export function stateAt(t, laps, markers, opts = {}) {
  const n = laps.length;
  const st = { phase: 'none', lap: -1, lapCount: n, current: NaN, last: null, best: null, sinceCross: Infinity };
  if (!n || markers.length !== n + 1) return st;
  if (t < markers[0]) {
    st.phase = 'pre';
    st.current = 0;
    st.best = opts.final ? bestOf(laps) : null;
    return st;
  }
  let i = 0;
  // Последняя метка, которую уже пересекли.
  while (i < n && t >= markers[i + 1]) i++;
  st.sinceCross = t - markers[i];
  const done = i >= n;
  st.phase = done ? 'done' : 'lap';
  st.lap = done ? n - 1 : i;
  if (!done) {
    const len = markers[i + 1] - markers[i];
    st.current = len > 0 ? ((t - markers[i]) / len) * laps[i].t : 0;
    if (!isFinite(st.current)) st.current = 0;
  }
  if (i > 0) {
    const li = i - 1;
    const prev = bestOf(laps, li);
    const lap = laps[li];
    const counts = lap.on !== false && isFinite(lap.t);
    st.last = {
      t: lap.t,
      i: li,
      on: lap.on !== false,
      // Сравнение с лучшим до этого круга: минус — быстрее.
      delta: prev && counts ? lap.t - prev.t : NaN,
      isBest: counts && (!prev || lap.t < prev.t),
      pos: lap.pos,
    };
  }
  st.best = opts.final ? bestOf(laps) : bestOf(laps, i);
  return st;
}

// Сдвигает одну метку перетаскиванием, не давая ей перескочить соседей.
export function moveMarker(markers, idx, time, minGap = 0.2) {
  const out = markers.slice();
  const lo = idx > 0 ? out[idx - 1] + minGap : -Infinity;
  const hi = idx < out.length - 1 ? out[idx + 1] - minGap : Infinity;
  out[idx] = Math.max(0, Math.min(hi, Math.max(lo, time)));
  return out;
}
