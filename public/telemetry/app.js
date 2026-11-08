// M-ELVN · телеметрия на видео. Главный файл страницы: состояние, шаги, предпросмотр и экспорт.
import { parseLapTime, fmtLap, fmtClock, fitMarkers, fitRatio, stateAt, moveMarker, bestOf, totalTime } from './laps.js?v=dev';
import { normalizeHeatUrl, fetchHeatHtml, parseHeat } from './heat.js?v=dev';
import { drawOverlay, DEFAULT_STYLE, mergeStyle } from './overlay.js?v=dev';
import { Timeline } from './timeline.js?v=dev';
import { GOOGLE_FONTS, loadGoogleFont, loadCustomFonts, addCustomFont } from './fonts.js?v=dev';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};

const S = {
  file: null,
  meta: null,         // { width, height, duration, fps, codec, decodable }
  heat: null,
  kart: '',
  driver: null,       // столбец заезда с выбранным картом
  laps: [],
  origLaps: [],
  markers: [],
  style: mergeStyle(store.get('tele:style')),
  step: 'video',
  exporting: null,
  gfonts: store.get('tele:gfonts', []),
  customFonts: [],
};

const video = $('#video');
const pv = $('#preview');
const pctx = pv.getContext('2d');
const assets = { logo: new Image() };
assets.logo.src = 'logo.png';
assets.logo.onload = () => scheduleRender();
let exportMod = null;
const loadExport = () => exportMod || (exportMod = import('./export.js?v=dev'));

// ---- Уведомления ----
let toastTimer = 0;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast' + (err ? ' err' : '')), err ? 6000 : 2800);
}

// ---- Шаги ----
function showStep(step) {
  S.step = step;
  $$('#steps button').forEach((b) => b.classList.toggle('on', b.dataset.step === step));
  $$('.pane').forEach((p) => (p.hidden = p.dataset.pane !== step));
  if (step === 'export') renderExport();
  if (step === 'laps') renderLaps();
}
function markSteps() {
  const done = { video: !!S.meta, heat: S.laps.length > 0, laps: S.markers.length > 0, design: false, export: false };
  $$('#steps button').forEach((b) => b.classList.toggle('done', !!done[b.dataset.step]));
}
$$('#steps button').forEach((b) => (b.onclick = () => showStep(b.dataset.step)));

// ---- Сохранение работы в браузере ----
const projKey = () => (S.file ? 'tele:proj:' + S.file.name + ':' + S.file.size : '');
let saveTimer = 0;
function saveProject() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const k = projKey();
    const data = { heatUrl: $('#heat-url').value, heat: S.heat, kart: S.kart, laps: S.laps, origLaps: S.origLaps, markers: S.markers };
    store.set('tele:last', { heatUrl: data.heatUrl, kart: S.kart });
    if (k && store.set(k, data)) flashSaved();
  }, 400);
}
function flashSaved() {
  const s = $('#saved');
  s.hidden = false;
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => (s.hidden = true), 1600);
}
let styleTimer = 0;
function saveStyle() {
  clearTimeout(styleTimer);
  styleTimer = setTimeout(() => store.set('tele:style', S.style), 300);
}

// ---- Видео ----
const fileKey = (f) => f.name + ':' + f.size;
async function openVideo(file) {
  if (!file) return;
  if (S.exporting) return toast('Дождитесь окончания сохранения', true);
  if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(file.name)) return toast('Это не видео. Выберите файл MP4 или MOV.', true);
  const prevKey = S.file ? fileKey(S.file) : '';
  S.file = file;
  if (video.src) URL.revokeObjectURL(video.src);
  $('#busy').hidden = false;
  video.src = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('decode'));
    });
  } catch (e) {
    $('#busy').hidden = true;
    S.meta = null;
    renderVideoInfo('Браузер не может показать это видео. Чаще всего так бывает с H.265 (HEVC): откройте сайт в Chrome или Edge, либо включите на камере запись в H.264.');
    return;
  }
  video.onloadeddata = null;
  video.muted = $('#mute').classList.contains('muted');
  S.meta = { width: video.videoWidth, height: video.videoHeight, duration: video.duration, fps: 30, codec: '', decodable: null };
  $('#busy').hidden = true;
  $('#drop').hidden = true;

  // Если это видео уже открывали — возвращаем метки и круги.
  const saved = store.get(projKey());
  if (saved && fileKey(file) !== prevKey) {
    S.heat = saved.heat || null;
    S.kart = saved.kart || '';
    S.laps = saved.laps || [];
    S.origLaps = saved.origLaps || S.laps.map((l) => Object.assign({}, l));
    S.markers = saved.markers || [];
    S.driver = S.heat ? S.heat.drivers.find((d) => d.kart === S.kart) || null : null;
    if (saved.heatUrl) $('#heat-url').value = saved.heatUrl;
    $('#heat-kart').value = S.kart;
    toast('Вернул круги и метки для этого видео');
  } else if (fileKey(file) !== prevKey) {
    S.markers = [];
  }
  timeline.setView(0, S.meta.duration);
  if (S.markers.length) zoomToHeat();
  sizePreview();
  renderVideoInfo();
  renderHeat();
  renderLaps();
  markSteps();
  saveProject();
  if (!S.laps.length) showStep('heat');
  else if (!S.markers.length) showStep('laps');

  // Частота кадров и кодек — из самого файла.
  loadExport().then(async (m) => {
    const info = await m.probeVideo(file).catch(() => null);
    if (!info || S.file !== file) return;
    S.meta.fps = info.fps || 30;
    S.meta.codec = info.codec || '';
    S.meta.decodable = info.decodable;
    if (!isFinite(S.meta.duration) && info.duration) { S.meta.duration = info.duration; timeline.setView(0, info.duration); }
    renderVideoInfo();
  });
}

function renderVideoInfo(error) {
  const box = $('#video-info');
  if (error) { box.innerHTML = '<div class="warn">' + esc(error) + '</div>'; return; }
  if (!S.meta) return;
  const m = S.meta;
  const mb = S.file.size / 1048576;
  box.className = '';
  box.innerHTML = '<dl class="facts">' +
    '<dt>Файл</dt><dd>' + esc(S.file.name) + '</dd>' +
    '<dt>Размер кадра</dt><dd>' + m.width + '×' + m.height + '</dd>' +
    '<dt>Длительность</dt><dd>' + fmtClock(m.duration, 0) + '</dd>' +
    '<dt>Кадров в секунду</dt><dd>' + (m.codec ? Math.round(m.fps * 100) / 100 : '…') + '</dd>' +
    '<dt>Вес</dt><dd>' + (mb > 1024 ? (mb / 1024).toFixed(2) + ' ГБ' : Math.round(mb) + ' МБ') + '</dd>' +
    '</dl>' +
    (m.decodable === false ? '<div class="warn">Видео в формате ' + esc(m.codec || '?') + ' браузер показывает, но не может пересобрать. Для экспорта откройте сайт в Chrome или Edge.</div>' : '');
  $('#video-pick').textContent = 'Выбрать другое видео';
}

$('#video-file').onchange = (e) => { openVideo(e.target.files[0]); e.target.value = ''; };
$('#video-pick').onclick = () => $('#video-file').click();
const vp = $('#viewport');
['dragenter', 'dragover'].forEach((ev) => vp.addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => vp.addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.remove('over'); }));
vp.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) openVideo(f); });

// ---- Предпросмотр ----
function sizePreview() {
  if (!S.meta) return;
  const r = vp.getBoundingClientRect();
  const ar = S.meta.width / S.meta.height;
  let w = r.width;
  let h = w / ar;
  if (h > r.height) { h = r.height; w = h * ar; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  pv.style.width = Math.floor(w) + 'px';
  pv.style.height = Math.floor(h) + 'px';
  // Не больше самого видео: незачем рисовать больше пикселей, чем в кадре.
  const k = Math.min(dpr, S.meta.width / w);
  pv.width = Math.max(2, Math.round(w * k));
  pv.height = Math.max(2, Math.round(h * k));
  renderFrame();
}
new ResizeObserver(() => sizePreview()).observe(vp);

function overlayInfo() {
  const d = S.driver;
  return {
    name: d ? d.name : '',
    kart: S.kart,
    heatBest: S.heat ? S.heat.best : null,
    maxLap: S.laps.reduce((a, l) => Math.max(a, isFinite(l.t) ? l.t : 0), 0) || 59.99,
  };
}
const stateFor = (t) => stateAt(t, S.laps, S.markers, { final: S.style.bestMode === 'final' });

let lastLapRow = -2;
function renderFrame(t) {
  if (t == null) t = video.currentTime || 0;
  if (S.meta && video.readyState >= 2) {
    pctx.drawImage(video, 0, 0, pv.width, pv.height);
    drawOverlay(pctx, pv.width, pv.height, stateFor(t), overlayInfo(), S.style, assets);
  }
  $('#clock').textContent = fmtClock(t) + (S.meta ? ' / ' + fmtClock(S.meta.duration, 0) : '');
  timeline.draw();
  const st = stateFor(t);
  const row = st.phase === 'lap' ? st.lap : -1;
  if (row !== lastLapRow) {
    lastLapRow = row;
    $$('#laps-box tr[data-i]').forEach((tr) => tr.classList.toggle('cur', Number(tr.dataset.i) === row));
  }
}
let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderFrame(); });
}
function loop() {
  if (video.paused || video.ended) { $('#play').classList.remove('playing'); renderFrame(); return; }
  renderFrame();
  timeline.follow(video.currentTime);
  requestAnimationFrame(loop);
}
video.addEventListener('play', () => { $('#play').classList.add('playing'); requestAnimationFrame(loop); });
video.addEventListener('pause', () => { $('#play').classList.remove('playing'); renderFrame(); });
video.addEventListener('seeked', () => renderFrame());

// ---- Управление воспроизведением ----
function seek(t) {
  if (!S.meta) return;
  video.currentTime = Math.max(0, Math.min(S.meta.duration - 0.001, t));
  renderFrame(video.currentTime);
}
function togglePlay() {
  if (!S.meta) return;
  if (video.paused) video.play().catch(() => {}); else video.pause();
}
function step(frames) {
  if (!S.meta) return;
  video.pause();
  seek(video.currentTime + frames / (S.meta.fps || 30));
}
$('#play').onclick = togglePlay;
$('#back').onclick = () => step(-1);
$('#fwd').onclick = () => step(1);
$('#mute').onclick = () => { const m = $('#mute').classList.toggle('muted'); video.muted = m; };
$('#mute').classList.add('muted');

// ---- Таймлайн ----
const timeline = new Timeline($('#timeline'), () => ({
  duration: S.meta ? S.meta.duration : 0,
  time: video.currentTime || 0,
  laps: S.laps,
  markers: S.markers,
  bestIdx: (bestOf(S.laps) || { i: -1 }).i,
}), {
  seek: (t) => { video.pause(); seek(t); },
  moveEdge: (idx, t) => {
    const end = S.markers[S.markers.length - 1];
    S.markers = idx === 0 ? fitMarkers(S.laps, Math.min(t, end - 1), end) : fitMarkers(S.laps, S.markers[0], Math.max(t, S.markers[0] + 1));
    scheduleRender();
  },
  moveMarker: (idx, t) => { S.markers = moveMarker(S.markers, idx, t); scheduleRender(); },
  dragEnd: () => { saveProject(); renderLaps(); },
});
function zoomToHeat() {
  if (!S.markers.length || !S.meta) return;
  const a = S.markers[0];
  const b = S.markers[S.markers.length - 1];
  const pad = Math.max(3, (b - a) * 0.04);
  timeline.setView(a - pad, b + pad);
}
$('#zoom-in').onclick = () => timeline.zoomBy(0.6, video.currentTime);
$('#zoom-out').onclick = () => timeline.zoomBy(1 / 0.6, video.currentTime);
$('#zoom-fit').onclick = () => (S.markers.length ? zoomToHeat() : S.meta && timeline.setView(0, S.meta.duration));

// ---- Старт и финиш ----
function needLaps() {
  if (!S.meta) { toast('Сначала откройте видео', true); return true; }
  if (!S.laps.length) { toast('Сначала загрузите заезд и укажите карт (шаг 2)', true); showStep('heat'); return true; }
  return false;
}
function setStart() {
  if (needLaps()) return;
  const t = video.currentTime;
  const end = S.markers.length ? S.markers[S.markers.length - 1] : NaN;
  S.markers = fitMarkers(S.laps, t, end > t + 1 ? end : NaN);
  afterMarkers(isFinite(end) && end > t + 1 ? 'Старт поставлен, круги подогнаны' : 'Старт поставлен. Теперь найдите финиш последнего круга');
}
function setEnd() {
  if (needLaps()) return;
  const t = video.currentTime;
  if (!S.markers.length) {
    S.markers = fitMarkers(S.laps, Math.max(0, t - totalTime(S.laps)), t);
    afterMarkers('Финиш поставлен. Старт стоит по сумме кругов — проверьте его');
    return;
  }
  if (t <= S.markers[0] + 1) return toast('Финиш должен быть позже старта', true);
  S.markers = fitMarkers(S.laps, S.markers[0], t);
  afterMarkers('Финиш поставлен, круги подогнаны');
}
function afterMarkers(msg) {
  if (msg) toast(msg);
  saveProject();
  markSteps();
  renderLaps();
  scheduleRender();
  if (S.step !== 'laps' && S.step !== 'design') showStep('laps');
}
$('#set-start').onclick = setStart;
$('#set-end').onclick = setEnd;

// ---- Заезд ----
async function loadHeat() {
  const url = normalizeHeatUrl($('#heat-url').value);
  if (!url) return toast('Вставьте ссылку на заезд вида https://timing.batyrshin.name/tracks/…/heats/…', true);
  $('#heat-url').value = url;
  const btn = $('#heat-load');
  btn.disabled = true;
  btn.textContent = 'Загружаю…';
  try {
    const html = await fetchHeatHtml(url, window.MELVN_API_URL);
    applyHeat(parseHeat(html, url));
  } catch (e) {
    toast('Сайт хронометража не ответил. Сохраните страницу заезда и откройте её ниже.', true);
    $('#heat-fallback').open = true;
  }
  btn.disabled = false;
  btn.textContent = 'Загрузить круги';
}
function applyHeat(h) {
  if (!h.drivers.length) return toast('На странице нет таблицы кругов. Это точно страница заезда?', true);
  S.heat = h;
  if (h.url && /heats\/\d+/.test(h.url)) $('#heat-url').value = h.url;
  const k = $('#heat-kart').value.trim() || S.kart;
  S.kart = '';
  S.driver = null;
  if (k && h.drivers.some((d) => d.kart === k)) pickKart(k, true);
  else {
    if (k) toast('Карта ' + k + ' в этом заезде нет. Выберите свой ниже.', true);
    S.laps = [];
    renderHeat();
    markSteps();
  }
  saveProject();
}
$('#heat-load').onclick = loadHeat;
$('#heat-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#heat-kart').focus(); } });
$('#heat-kart').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (S.heat && normalizeHeatUrl($('#heat-url').value) === S.heat.url) pickKart($('#heat-kart').value.trim());
  else loadHeat();
});
$('#heat-file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const html = await f.text();
  applyHeat(parseHeat(html, normalizeHeatUrl($('#heat-url').value)));
};

function pickKart(k, quiet, driverIdx) {
  if (!S.heat) return;
  k = String(k || '').trim();
  const list = S.heat.drivers.filter((d) => d.kart === k);
  if (!list.length) return toast('Карта ' + k + ' нет в этом заезде', true);
  const d = list[driverIdx || 0];
  const sameLaps = S.laps.length === d.laps.length;
  S.kart = k;
  S.driver = d;
  $('#heat-kart').value = k;
  S.laps = d.laps.map((l) => ({ t: l.t, on: true, pos: l.pos }));
  S.origLaps = S.laps.map((l) => Object.assign({}, l));
  // Если старт и финиш уже стоят — пересчитываем круги между ними.
  if (S.markers.length) S.markers = fitMarkers(S.laps, S.markers[0], sameLaps ? S.markers[S.markers.length - 1] : NaN);
  renderHeat();
  renderLaps();
  markSteps();
  saveProject();
  scheduleRender();
  if (!quiet) toast('Карт ' + k + ': ' + d.laps.length + ' кругов');
  else toast('Загружено: карт ' + k + ', ' + d.laps.length + ' кругов');
}

const ruDate = (iso) => {
  if (!iso) return '';
  const m = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const p = iso.split('-');
  return Number(p[2]) + ' ' + m[Number(p[1]) - 1] + ' ' + p[0];
};
function renderHeat() {
  const box = $('#heat-box');
  const h = S.heat;
  if (!h) { box.innerHTML = ''; return; }
  const karts = h.drivers.slice().sort((a, b) => (Number(a.kart) || 0) - (Number(b.kart) || 0));
  const d = S.driver;
  box.innerHTML = '<div class="heat-card">' +
    '<div class="heat-title">' + esc(h.name || 'Заезд') + '</div>' +
    '<div class="heat-meta">' + esc([h.track, ruDate(h.date), h.time].filter(Boolean).join(', ')) + '</div>' +
    (d ? '<div class="picked"><div class="big">Карт ' + esc(d.kart) + '</div><div class="best">' + fmtLap(d.best) + '</div>' +
      '<div class="sub">' + esc(d.name) + ', P' + d.pos + ' из ' + h.drivers.length + ', ' + d.laps.length + ' кругов</div><div class="sub">лучший</div></div>' : '') +
    '<h3 style="margin:16px 0 8px">' + (d ? 'Другой карт' : 'Выберите свой карт') + '</h3>' +
    '<div class="karts">' + karts.map((x) => {
      const idx = h.drivers.filter((y) => y.kart === x.kart).indexOf(x);
      return '<button type="button" class="kart' + (d === x ? ' on' : '') + '" data-kart="' + esc(x.kart) + '" data-idx="' + idx + '"><b>' + esc(x.kart || '?') + '</b><span>P' + x.pos + ' · ' + fmtLap(x.best) + '</span></button>';
    }).join('') + '</div>' +
    (d ? '<button class="btn wide" style="margin-top:16px" type="button" id="to-laps">Дальше: отметить круги на видео</button>' : '') +
    '</div>';
  $$('[data-kart]', box).forEach((b) => (b.onclick = () => pickKart(b.dataset.kart, false, Number(b.dataset.idx))));
  const next = $('#to-laps');
  if (next) next.onclick = () => showStep('laps');
}

// ---- Круги ----
function refit() {
  if (!S.markers.length) return;
  S.markers = fitMarkers(S.laps, S.markers[0], S.markers[S.markers.length - 1]);
}
function renderLaps() {
  const fit = $('#fit-box');
  const box = $('#laps-box');
  if (!S.laps.length) {
    fit.innerHTML = '<div class="fit">Сначала загрузите заезд и выберите карт на шаге 2.</div>';
    box.innerHTML = '';
    return;
  }
  const total = totalTime(S.laps);
  if (S.markers.length === S.laps.length + 1) {
    const span = S.markers[S.markers.length - 1] - S.markers[0];
    const ratio = fitRatio(S.laps, S.markers);
    const diff = span - total;
    const bad = Math.abs(ratio - 1) > 0.02;
    fit.innerHTML = '<div class="fit ' + (bad ? 'bad' : 'good') + '">' +
      'На видео от старта до финиша <b>' + fmtClock(span) + '</b>, по хронометражу <b>' + fmtClock(total) + '</b>' +
      (bad ? '. Разница ' + Math.abs(diff).toFixed(1) + ' с — похоже, старт или финиш стоит не на том круге.' : '. Совпадает, разница ' + Math.abs(diff).toFixed(2) + ' с.') +
      '<div class="btn-row"><button class="btn ghost small" type="button" id="refit">Расставить круги заново</button>' +
      '<button class="btn ghost small" type="button" id="go-start">К старту</button>' +
      '<button class="btn ghost small" type="button" id="clear-marks">Убрать метки</button></div></div>';
    $('#refit').onclick = () => { refit(); afterMarkers('Круги расставлены по времени из хронометража'); };
    $('#go-start').onclick = () => { video.pause(); seek(S.markers[0]); };
    $('#clear-marks').onclick = () => { S.markers = []; afterMarkers('Метки убраны'); };
  } else {
    fit.innerHTML = '<div class="fit">Кругов: <b>' + S.laps.length + '</b>, всего <b>' + fmtClock(total) + '</b>. Меток на видео пока нет.</div>';
  }
  const best = bestOf(S.laps);
  const has = S.markers.length === S.laps.length + 1;
  box.innerHTML = '<table class="laps"><thead><tr><th>Круг</th><th>Время</th><th>На видео</th><th title="Учитывать в лучшем круге">Учёт</th><th></th></tr></thead><tbody>' +
    S.laps.map((l, i) => '<tr data-i="' + i + '" class="' + (best && best.i === i ? 'best' : '') + (l.on === false ? ' off' : '') + '">' +
      '<td class="no">' + (i + 1) + '</td>' +
      '<td><input class="lt" value="' + fmtLap(l.t) + '" data-lt="' + i + '" aria-label="Время круга ' + (i + 1) + '"></td>' +
      '<td>' + (has ? '<button class="at" type="button" data-at="' + i + '">' + fmtClock(S.markers[i], 2) + '</button>' : '—') + '</td>' +
      '<td><input type="checkbox" data-on="' + i + '"' + (l.on === false ? '' : ' checked') + ' aria-label="Учитывать круг ' + (i + 1) + '"></td>' +
      '<td><button class="x" type="button" data-del="' + i + '" aria-label="Удалить круг ' + (i + 1) + '">×</button></td></tr>').join('') +
    '</tbody></table>' +
    '<div class="btn-row" style="margin-top:12px"><button class="btn ghost small" type="button" id="lap-add">Добавить круг</button>' +
    '<button class="btn ghost small" type="button" id="lap-reset">Вернуть круги из хронометража</button></div>' +
    '<p class="note">Снимите галочку «Учёт» у круга с пит-стопом или аварией, чтобы он не считался лучшим.</p>';
  lastLapRow = -2;
  $$('[data-lt]', box).forEach((inp) => (inp.onchange = () => {
    const i = Number(inp.dataset.lt);
    const v = parseLapTime(inp.value);
    if (!(v > 0)) { inp.value = fmtLap(S.laps[i].t); return toast('Время круга пишется так: 37.322 или 1:09.311', true); }
    S.laps[i].t = v;
    refit();
    afterLapsChange();
  }));
  $$('[data-on]', box).forEach((c) => (c.onchange = () => { S.laps[Number(c.dataset.on)].on = c.checked; afterLapsChange(); }));
  $$('[data-at]', box).forEach((b) => (b.onclick = () => { video.pause(); seek(S.markers[Number(b.dataset.at)]); }));
  $$('[data-del]', box).forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.del);
    const n = S.laps.length;
    S.laps.splice(i, 1);
    if (S.markers.length === n + 1) {
      // Первый круг убрали — старт переезжает на следующую метку, последний — финиш на предыдущую.
      if (i === 0) S.markers.splice(0, 1);
      else if (i === n - 1) S.markers.splice(n, 1);
      else { S.markers.splice(i + 1, 1); refit(); }
    }
    if (!S.laps.length) S.markers = [];
    afterLapsChange();
  }));
  $('#lap-add').onclick = () => {
    const avg = totalTime(S.laps) / S.laps.length || 40;
    S.laps.push({ t: Math.round(avg * 1000) / 1000, on: true, pos: null });
    if (S.markers.length) S.markers.push(S.markers[S.markers.length - 1] + avg);
    afterLapsChange();
  };
  $('#lap-reset').onclick = () => {
    S.laps = S.origLaps.map((l) => Object.assign({}, l));
    if (S.markers.length) S.markers = fitMarkers(S.laps, S.markers[0], NaN);
    afterLapsChange();
    toast('Круги как в хронометраже');
  };
}
function afterLapsChange() {
  saveProject();
  markSteps();
  renderLaps();
  scheduleRender();
}

// ---- Дизайн ----
const PRESETS = [
  { name: 'M-ELVN', dot: '#ff5a00', set: { panel: '#101011', panelAlpha: 78, accent: '#ff5a00', text: '#ffffff', muted: '#a1a1a8', record: '#ff5a00', faster: '#3ddc84', slower: '#ff5257' } },
  { name: 'Светлая', dot: '#ffffff', set: { panel: '#ffffff', panelAlpha: 94, accent: '#ff5a00', text: '#101011', muted: '#6b6b73', record: '#ff5a00', faster: '#0f9d58', slower: '#e5383b' } },
  { name: 'Карбон', dot: '#3a3a3f', set: { panel: '#000000', panelAlpha: 55, accent: '#ffffff', text: '#ffffff', muted: '#c4c4ca', record: '#ffffff', faster: '#3ddc84', slower: '#ff5257' } },
  { name: 'Оранжевая', dot: '#ff5a00', ring: true, set: { panel: '#ff5a00', panelAlpha: 92, accent: '#101011', text: '#ffffff', muted: '#ffe0cc', record: '#101011', faster: '#101011', slower: '#ffffff' } },
];
const getPath = (k) => k.split('.').reduce((o, p) => (o ? o[p] : undefined), S.style);
function setPath(k, v) {
  const parts = k.split('.');
  let o = S.style;
  while (parts.length > 1) o = o[parts.shift()];
  o[parts[0]] = v;
}
const OUT = { size: '%', marginX: '%', marginY: '%', panelAlpha: '%', shade: '%', blur: '', radius: '' };

function fontOptions() {
  const custom = S.customFonts.map((f) => '<option value="' + esc(f) + '">' + esc(f) + '</option>').join('');
  const extra = S.gfonts.filter((f) => !GOOGLE_FONTS.some((g) => g.name === f));
  return (custom ? '<optgroup label="Мои шрифты">' + custom + '</optgroup>' : '') +
    '<optgroup label="С кириллицей">' + GOOGLE_FONTS.filter((g) => g.cyr).map((g) => '<option>' + esc(g.name) + '</option>').join('') + '</optgroup>' +
    '<optgroup label="Только латиница и цифры">' + GOOGLE_FONTS.filter((g) => !g.cyr).map((g) => '<option>' + esc(g.name) + '</option>').join('') + '</optgroup>' +
    (extra.length ? '<optgroup label="Подключённые">' + extra.map((f) => '<option>' + esc(f) + '</option>').join('') + '</optgroup>' : '');
}
function fillDesign() {
  $$('[data-fonts]').forEach((sel) => {
    sel.innerHTML = fontOptions();
    const v = getPath(sel.dataset.k);
    if (!$$('option', sel).some((o) => o.value === v)) sel.insertAdjacentHTML('afterbegin', '<option>' + esc(v) + '</option>');
  });
  $$('.design [data-k]').forEach((el) => {
    const v = getPath(el.dataset.k);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
  $$('[data-out]').forEach((o) => (o.textContent = getPath(o.dataset.out) + (OUT[o.dataset.out] || '')));
  $$('[data-layout]').forEach((b) => { b.classList.toggle('on', b.dataset.layout === S.style.layout); b.setAttribute('aria-checked', b.dataset.layout === S.style.layout); });
  $$('[data-anchor]').forEach((b) => { b.classList.toggle('on', b.dataset.anchor === S.style.anchor); b.setAttribute('aria-checked', b.dataset.anchor === S.style.anchor); });
}
function styleChanged() { saveStyle(); scheduleRender(); }
function ensureFonts() {
  [S.style.numFont, S.style.labelFont].forEach((f) => loadGoogleFont(f).then(() => scheduleRender()));
}

$$('.design [data-k]').forEach((el) => {
  const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
  el.addEventListener(ev, () => {
    const k = el.dataset.k;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'range' || el.hasAttribute('data-num')) v = Number(v);
    setPath(k, v);
    const out = $('[data-out="' + k + '"]');
    if (out) out.textContent = v + (OUT[k] || '');
    if (k === 'numFont' || k === 'labelFont') ensureFonts();
    styleChanged();
  });
});
$$('[data-layout]').forEach((b) => (b.onclick = () => { S.style.layout = b.dataset.layout; fillDesign(); styleChanged(); }));
$$('[data-anchor]').forEach((b) => (b.onclick = () => { S.style.anchor = b.dataset.anchor; fillDesign(); styleChanged(); }));
$('#presets').innerHTML = PRESETS.map((p, i) => '<button type="button" class="preset" data-preset="' + i + '"><i style="background:' + p.dot + (p.ring ? ';box-shadow:inset 0 0 0 4px #101011' : ';box-shadow:inset 0 0 0 1px #3a3a3f') + '"></i>' + esc(p.name) + '</button>').join('');
$$('[data-preset]').forEach((b) => (b.onclick = () => { Object.assign(S.style, PRESETS[Number(b.dataset.preset)].set); fillDesign(); styleChanged(); }));

$('#font-file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const name = await addCustomFont(f);
    if (S.customFonts.indexOf(name) < 0) S.customFonts.push(name);
    S.style.numFont = name;
    fillDesign();
    styleChanged();
    toast('Шрифт «' + name + '» добавлен и выбран для цифр');
  } catch (err) {
    toast('Не получилось прочитать шрифт. Подойдут файлы OTF, TTF или WOFF.', true);
  }
};
$('#gfont-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#gfont-name').value.trim().replace(/\s+/g, ' ');
  if (!name) return;
  const ok = await loadGoogleFont(name);
  if (!ok) return toast('Шрифт «' + name + '» не нашёлся в Google Fonts. Проверьте написание, как на fonts.google.com.', true);
  if (S.gfonts.indexOf(name) < 0) { S.gfonts.push(name); store.set('tele:gfonts', S.gfonts); }
  S.style.numFont = name;
  $('#gfont-name').value = '';
  fillDesign();
  styleChanged();
  toast('Шрифт «' + name + '» подключён и выбран для цифр');
};
$('#style-save').onclick = () => {
  const blob = new Blob([JSON.stringify({ melvnTelemetryStyle: 1, style: S.style }, null, 2)], { type: 'application/json' });
  download(blob, 'm-elvn-telemetry-style.json');
};
$('#style-file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    S.style = mergeStyle(data.style || data);
    fillDesign();
    ensureFonts();
    styleChanged();
    toast('Стиль загружен');
  } catch (err) {
    toast('Это не файл стиля', true);
  }
};
$('#style-reset').onclick = () => { S.style = mergeStyle(DEFAULT_STYLE); fillDesign(); ensureFonts(); styleChanged(); toast('Стиль M-ELVN'); };

// ---- Экспорт ----
function exportRange() {
  const all = $('#ex-range').value === 'all' || S.markers.length < 2;
  if (all) return { from: 0, to: S.meta.duration };
  const pad = Number($('#ex-pad').value);
  return { from: Math.max(0, S.markers[0] - pad), to: Math.min(S.meta.duration, S.markers[S.markers.length - 1] + pad) };
}
function outSize() {
  const want = Number($('#ex-size').value);
  let W = S.meta.width;
  let H = S.meta.height;
  if (want && want < Math.min(W, H)) { const k = want / Math.min(W, H); W = Math.round((W * k) / 2) * 2; H = Math.round((H * k) / 2) * 2; }
  return { W, H };
}
function renderExport() {
  $('#ex-pad-out').textContent = $('#ex-pad').value + ' с';
  $('#ex-pad-row').hidden = $('#ex-range').value === 'all';
  const sum = $('#ex-summary');
  const go = $('#ex-go');
  if (!S.meta) { sum.textContent = 'Сначала откройте видео.'; go.disabled = true; return; }
  go.disabled = !!S.exporting;
  const r = exportRange();
  const { W, H } = outSize();
  const warn = !S.markers.length ? '<br>Меток кругов нет — телеметрии на видео не будет. Отметьте старт и финиш на шаге 3.' : '';
  sum.innerHTML = 'Будет сохранено <b>' + fmtClock(r.to - r.from, 0) + '</b> видео, с ' + fmtClock(r.from, 0) + ' по ' + fmtClock(r.to, 0) + ', кадр <b>' + W + '×' + H + '</b>.' + warn;
}
['ex-range', 'ex-pad', 'ex-size', 'ex-quality', 'ex-mode'].forEach((id) => $('#' + id).addEventListener('input', renderExport));

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const baseName = () => (S.file ? S.file.name.replace(/\.[^.]+$/, '') : 'video');

$('#ex-go').onclick = async () => {
  if (!S.meta || S.exporting) return;
  video.pause();
  const mode = $('#ex-mode').value;
  const name = baseName() + (mode === 'green' ? '_telemetry_green' : '_telemetry') + '.mp4';
  const mod = await loadExport();
  const target = await mod.pickTarget(name);
  if (!target) return;
  const r = exportRange();
  const style = mergeStyle(S.style);
  const info = overlayInfo();
  const laps = S.laps.map((l) => Object.assign({}, l));
  const markers = S.markers.slice();
  const opts = { final: style.bestMode === 'final' };
  S.exporting = { conv: null, started: performance.now() };
  $('#ex-go').disabled = true;
  $('#ex-progress').hidden = false;
  $('#ex-bar').style.width = '0%';
  $('#ex-status').textContent = 'Готовлю…';
  try {
    const res = await mod.exportVideo({
      file: S.file,
      target,
      from: r.from,
      to: r.to,
      height: Number($('#ex-size').value),
      quality: $('#ex-quality').value,
      mode,
      draw: (ctx, W, H, t) => drawOverlay(ctx, W, H, stateAt(t, laps, markers, opts), info, style, assets),
      onConversion: (c) => { if (S.exporting) S.exporting.conv = c; },
      onProgress: (p) => {
        $('#ex-bar').style.width = (p * 100).toFixed(1) + '%';
        const spent = (performance.now() - S.exporting.started) / 1000;
        const left = p > 0.02 ? (spent / p) * (1 - p) : NaN;
        $('#ex-status').textContent = Math.floor(p * 100) + '%' + (isFinite(left) ? ', осталось около ' + (left > 90 ? Math.round(left / 60) + ' мин' : Math.max(1, Math.round(left)) + ' с') : '');
      },
    });
    if (res.blob) download(res.blob, name);
    $('#ex-bar').style.width = '100%';
    $('#ex-status').textContent = 'Готово: ' + name;
    toast('Видео сохранено');
  } catch (e) {
    const canceled = e && /cancel/i.test(e.name + ' ' + e.message);
    $('#ex-status').textContent = canceled ? 'Отменено' : 'Ошибка';
    if (!canceled) toast((e && e.message) || 'Не получилось сохранить видео', true);
  }
  S.exporting = null;
  renderExport();
};
$('#ex-cancel').onclick = () => {
  if (S.exporting && S.exporting.conv) S.exporting.conv.cancel();
};
window.addEventListener('beforeunload', (e) => { if (S.exporting) { e.preventDefault(); e.returnValue = ''; } });

$('#ex-frame').onclick = () => {
  if (!S.meta) return;
  const c = document.createElement('canvas');
  c.width = S.meta.width;
  c.height = S.meta.height;
  const ctx = c.getContext('2d');
  if ($('#ex-mode').value === 'green') { ctx.fillStyle = '#00b140'; ctx.fillRect(0, 0, c.width, c.height); }
  else ctx.drawImage(video, 0, 0, c.width, c.height);
  drawOverlay(ctx, c.width, c.height, stateFor(video.currentTime), overlayInfo(), S.style, assets);
  c.toBlob((b) => b && download(b, baseName() + '_' + fmtClock(video.currentTime, 0).replace(/:/g, '-') + '.png'), 'image/png');
};

// ---- Клавиши ----
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if ($('#help').open) return;
  const k = e.key;
  if (k === ' ' || k === 'k' || k === 'л') { e.preventDefault(); togglePlay(); }
  else if (k === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -(S.meta ? S.meta.fps : 30) : -1); }
  else if (k === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? (S.meta ? S.meta.fps : 30) : 1); }
  else if (k === 's' || k === 'S' || k === 'ы' || k === 'Ы') { e.preventDefault(); setStart(); }
  else if (k === 'f' || k === 'F' || k === 'а' || k === 'А') { e.preventDefault(); setEnd(); }
  else if (k === '[' || k === ']' || k === 'х' || k === 'ъ') {
    if (!S.markers.length) return;
    e.preventDefault();
    const t = video.currentTime;
    const fwd = k === ']' || k === 'ъ';
    const m = fwd ? S.markers.find((x) => x > t + 0.01) : S.markers.slice().reverse().find((x) => x < t - 0.01);
    if (m != null) { video.pause(); seek(m); }
  }
});

// ---- Справка ----
$('#help-btn').onclick = () => $('#help').showModal();
if (!store.get('tele:seenHelp')) {
  store.set('tele:seenHelp', true);
  setTimeout(() => $('#help').showModal(), 400);
}

// ---- Старт страницы ----
(async function init() {
  const last = store.get('tele:last');
  if (last) {
    if (last.heatUrl) $('#heat-url').value = last.heatUrl;
    if (last.kart) $('#heat-kart').value = last.kart;
  }
  S.customFonts = await loadCustomFonts();
  S.gfonts.forEach((f) => loadGoogleFont(f));
  fillDesign();
  ensureFonts();
  renderLaps();
  renderExport();
  markSteps();
  timeline.resize();
})();
