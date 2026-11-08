// Рисует телеметрию поверх кадра. Одна и та же функция работает в предпросмотре и при экспорте,
// поэтому то, что видно на экране, совпадает с готовым видео.
import { fmtLap, fmtDelta } from './laps.js?v=dev';

export const DEFAULT_STYLE = {
  layout: 'card',         // card — карточка, bar — полоса, mini — только цифры
  anchor: 'bl',           // tl tc tr ml mc mr bl bc br
  marginX: 3,             // отступ от края, % ширины кадра
  marginY: 5,             // отступ от края, % высоты кадра
  size: 100,              // размер, %
  panel: '#101011',
  panelAlpha: 78,         // непрозрачность плашки, %
  blur: 10,               // размытие видео под плашкой
  radius: 18,
  shade: 30,              // затемнение кадра со стороны телеметрии, %
  accent: '#ff5a00',
  text: '#ffffff',
  muted: '#a1a1a8',
  faster: '#3ddc84',
  slower: '#ff5257',
  record: '#ff5a00',
  numFont: 'Unbounded',
  numWeight: 700,
  labelFont: 'Onest',
  labelWeight: 500,
  lower: true,            // подписи строчными, как на картинках команды
  digits: 2,              // знаков у бегущего времени
  flash: true,            // подсветка круга после пересечения линии
  bestMode: 'live',       // live — лучший на текущий момент, final — итоговый с самого начала
  before: 'show',         // до старта: show / hide
  after: 'show',          // после финиша: show / hide
  show: { logo: true, name: false, kart: true, lapNo: true, pos: false, current: true, last: true, delta: true, best: true, bestLap: true, heatBest: false },
  labels: { current: 'текущий', last: 'последний', best: 'лучший', lap: 'круг', finish: 'финиш', heatBest: 'бест заезда', newBest: 'новый лучший' },
};

export function mergeStyle(s) {
  const d = DEFAULT_STYLE;
  s = s || {};
  return Object.assign({}, d, s, { show: Object.assign({}, d.show, s.show), labels: Object.assign({}, d.labels, s.labels) });
}

const FLASH = 3; // секунд подсветки после пересечения линии

function hexA(hex, a) {
  const m = String(hex).replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m.padEnd(6, '0');
  const n = parseInt(v.slice(0, 6), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + Math.max(0, Math.min(1, a)) + ')';
}

function rr(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const font = (w, px, fam) => w + ' ' + Math.round(px * 100) / 100 + 'px "' + fam + '", system-ui, sans-serif';

// Цифры одинаковой ширины, чтобы бегущее время не «дрожало», даже если у шрифта цифры разной ширины.
function numWidth(ctx, str) {
  const dw = ctx.measureText('0').width;
  let w = 0;
  for (const ch of str) w += /\d/.test(ch) ? dw : ctx.measureText(ch).width;
  return w;
}
function drawNum(ctx, str, x, y, align) {
  const dw = ctx.measureText('0').width;
  const w = numWidth(ctx, str);
  let cx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  const prev = ctx.textAlign;
  ctx.textAlign = 'center';
  for (const ch of str) {
    const cw = /\d/.test(ch) ? dw : ctx.measureText(ch).width;
    ctx.fillText(ch, cx + cw / 2, y);
    cx += cw;
  }
  ctx.textAlign = prev;
  return w;
}

function textW(ctx, f, s) { ctx.font = f; return ctx.measureText(s).width; }

// Позиция блока w×h в кадре по якорю и отступам.
function place(W, H, w, h, st) {
  const mx = (W * st.marginX) / 100;
  const my = (H * st.marginY) / 100;
  const a = st.anchor || 'bl';
  const x = a[1] === 'l' ? mx : a[1] === 'r' ? W - mx - w : (W - w) / 2;
  const y = a[0] === 't' ? my : a[0] === 'b' ? H - my - h : (H - h) / 2;
  return { x: Math.round(x), y: Math.round(y) };
}

// Затемнение кадра с той стороны, где стоит телеметрия, — чтобы цифры читались на ярком видео.
function drawShade(ctx, W, H, st) {
  const a = st.shade / 100;
  if (!(a > 0)) return;
  const an = st.anchor || 'bl';
  let g;
  if (an[0] === 'b') g = ctx.createLinearGradient(0, H, 0, H * 0.45);
  else if (an[0] === 't') g = ctx.createLinearGradient(0, 0, 0, H * 0.55);
  else if (an[1] === 'l') g = ctx.createLinearGradient(0, 0, W * 0.5, 0);
  else if (an[1] === 'r') g = ctx.createLinearGradient(W, 0, W * 0.5, 0);
  if (g) {
    g.addColorStop(0, 'rgba(0,0,0,' + a + ')');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = 'rgba(0,0,0,' + a * 0.6 + ')';
  }
  ctx.fillRect(0, 0, W, H);
}

// Плашка: размытие видео под ней, заливка и цветная полоска команды слева.
function drawPanel(ctx, x, y, w, h, u, st, glow) {
  const r = st.radius * u;
  if (st.blur > 0 && st.panelAlpha < 100) {
    const b = st.blur * u;
    const pad = Math.ceil(b * 2);
    const sx = Math.max(0, Math.floor(x - pad));
    const sy = Math.max(0, Math.floor(y - pad));
    const sw = Math.min(ctx.canvas.width - sx, Math.ceil(w + pad * 2));
    const sh = Math.min(ctx.canvas.height - sy, Math.ceil(h + pad * 2));
    if (sw > 0 && sh > 0) {
      const tmp = blurCanvas(sw, sh);
      const tctx = tmp.getContext('2d');
      tctx.clearRect(0, 0, sw, sh);
      tctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      ctx.save();
      rr(ctx, x, y, w, h, r);
      ctx.clip();
      ctx.filter = 'blur(' + b + 'px)';
      ctx.drawImage(tmp, 0, 0, sw, sh, sx, sy, sw, sh);
      ctx.restore();
    }
  }
  if (st.panelAlpha > 0) {
    ctx.fillStyle = hexA(st.panel, st.panelAlpha / 100);
    rr(ctx, x, y, w, h, r);
    ctx.fill();
  }
  if (glow > 0) {
    ctx.save();
    ctx.strokeStyle = hexA(st.record, glow);
    ctx.lineWidth = 3 * u;
    rr(ctx, x + 1.5 * u, y + 1.5 * u, w - 3 * u, h - 3 * u, Math.max(0, r - 1.5 * u));
    ctx.stroke();
    ctx.restore();
  }
}
let _blur = null;
function blurCanvas(w, h) {
  if (!_blur) _blur = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  if (_blur.width < w) _blur.width = w;
  if (_blur.height < h) _blur.height = h;
  return _blur;
}

// Готовит строки для любого макета.
function content(s, info, st) {
  const L = {};
  Object.keys(st.labels).forEach((k) => (L[k] = st.lower ? String(st.labels[k]).toLowerCase() : st.labels[k]));
  const n = s.lapCount;
  const lapNo = s.phase === 'pre' ? 0 : s.phase === 'done' ? n : s.lap + 1;
  const cur = s.phase === 'done' ? L.finish : fmtLap(s.current, st.digits);
  const last = s.last;
  const flashK = st.flash && last && s.sinceCross < FLASH ? 1 - s.sinceCross / FLASH : 0;
  let deltaText = '';
  let deltaColor = st.muted;
  if (last) {
    if (last.isBest && isFinite(last.delta)) { deltaText = fmtDelta(last.delta); deltaColor = st.record; }
    else if (last.isBest) { deltaText = ''; deltaColor = st.record; }
    else if (isFinite(last.delta)) { deltaText = fmtDelta(last.delta); deltaColor = last.delta < 0 ? st.faster : st.slower; }
  }
  const lastColor = last && last.isBest && flashK > 0 ? st.record : st.text;
  return {
    L,
    lapNo, n,
    lapText: lapNo + '/' + n,
    pos: last && last.pos ? 'P' + last.pos : '',
    cur,
    curIsText: s.phase === 'done',
    last: last ? fmtLap(last.t) : '—',
    lastColor,
    deltaText, deltaColor,
    newBest: !!(last && last.isBest && flashK > 0),
    best: s.best ? fmtLap(s.best.t) : '—',
    bestLap: s.best ? L.lap + ' ' + (s.best.i + 1) : '',
    flashK,
    flashColor: last ? (last.isBest ? st.record : isFinite(last.delta) ? (last.delta < 0 ? st.faster : st.slower) : st.muted) : st.muted,
    heatBest: info.heatBest ? fmtLap(info.heatBest.t) : '',
    heatBestName: info.heatBest ? info.heatBest.name : '',
    name: info.name || '',
    kart: info.kart ? (st.lower ? 'карт ' : 'Карт ') + info.kart : '',
    template: fmtLap(info.maxLap || 59.99, st.digits),
    template3: fmtLap(info.maxLap || 59.99, 3),
  };
}

// Главная функция. ctx — кадр W×H (видео уже нарисовано), s — stateAt(), info — пилот и заезд.
export function drawOverlay(ctx, W, H, s, info, style, assets) {
  const st = mergeStyle(style);
  if (!s || s.phase === 'none') return;
  if (s.phase === 'pre' && st.before === 'hide') return;
  if (s.phase === 'done' && st.after === 'hide') return;
  const u = (Math.min(W, H) / 1080) * (st.size / 100);
  const c = content(s, info, st);
  logoColor = st.text;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  drawShade(ctx, W, H, st);
  if (st.layout === 'bar') drawBar(ctx, W, H, u, st, c, assets);
  else if (st.layout === 'mini') drawMini(ctx, W, H, u, st, c, assets);
  else drawCard(ctx, W, H, u, st, c, assets);
  ctx.restore();
}

// Логотип белый с оранжевым тире. На светлой плашке белые части перекрашиваются в цвет цифр.
const tinted = new Map();
function tintLogo(img, color) {
  const key = color;
  if (tinted.has(key)) return tinted.get(key);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  try {
    const d = g.getImageData(0, 0, c.width, c.height);
    const n = parseInt(String(color).replace('#', '').padEnd(6, '0').slice(0, 6), 16);
    const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
    for (let i = 0; i < d.data.length; i += 4) {
      const p = d.data;
      // Белые и серые пиксели (не оранжевые) перекрашиваем.
      if (Math.abs(p[i] - p[i + 2]) < 60) { p[i] = r; p[i + 1] = gg; p[i + 2] = b; }
    }
    g.putImageData(d, 0, 0);
  } catch (e) { /* без перекраски */ }
  tinted.set(key, c);
  return c;
}
let logoColor = '#ffffff';
function logoSize(assets, h) {
  const img = assets && assets.logo;
  if (!img || !img.width) return null;
  const src = /^#?f{6}$/i.test(logoColor.replace('#', '')) || logoColor.toLowerCase() === '#ffffff' ? img : tintLogo(img, logoColor);
  return { img: src, w: (img.width / img.height) * h, h };
}

// ---- Карточка ----
function drawCard(ctx, W, H, u, st, c, assets) {
  const sh = st.show;
  const p = 24 * u;
  const bar = 6 * u;
  const NF = (px) => font(st.numWeight, px * u, st.numFont);
  const LF = (px, w) => font(w || st.labelWeight, px * u, st.labelFont);
  const colGap = 18 * u;

  // Ширина по самому длинному содержимому, чтобы карточка не прыгала от круга к кругу.
  ctx.font = NF(64);
  const curW = Math.max(numWidth(ctx, c.template), c.curIsText ? textW(ctx, NF(64), c.cur) : 0, textW(ctx, NF(64), st.lower ? 'финиш' : 'ФИНИШ'));
  ctx.font = NF(30);
  const smallNumW = numWidth(ctx, c.template3);
  const colW = Math.max(smallNumW, textW(ctx, LF(16), c.L.last), textW(ctx, LF(16), c.L.newBest), 150 * u);
  let w = Math.max(curW, colW * 2 + colGap, 300 * u) + p * 2 + bar;
  const logo = sh.logo ? logoSize(assets, 24 * u) : null;

  const whoName = sh.name && c.name ? c.name : '';
  const whoKart = sh.kart && c.kart ? c.kart : '';
  const headH = logo || whoName || whoKart || sh.lapNo || sh.pos ? 34 * u : 0;
  const nameLine = !!(logo && (whoName || whoKart));
  const curH = sh.current ? 22 * u + 66 * u : 0;
  const colsOn = sh.last || sh.best;
  const colsH = colsOn ? 22 * u + 34 * u + 24 * u : 0;
  const heatH = sh.heatBest && c.heatBest ? 38 * u : 0;
  const blocks = [headH + (nameLine ? 26 * u : 0), curH, colsH, heatH].filter((x) => x > 0);
  const h = p * 2 + blocks.reduce((a, b) => a + b, 0) + Math.max(0, blocks.length - 1) * 18 * u;

  // Заголовок может быть шире.
  if (headH) {
    const headW = (logo ? logo.w + 14 * u : textW(ctx, LF(22, 700), whoName) + textW(ctx, LF(16), whoKart) + 26 * u) + textW(ctx, LF(16), c.L.lap + ' ') + textW(ctx, NF(20), c.lapText) + (sh.pos && c.pos ? 60 * u : 0) + 30 * u;
    w = Math.max(w, headW + p * 2 + bar);
  }
  const pos = place(W, H, w, h, st);
  const x0 = pos.x;
  const y0 = pos.y;
  drawPanel(ctx, x0, y0, w, h, u, st, c.newBest ? c.flashK : 0);
  // Полоска команды слева.
  ctx.fillStyle = st.accent;
  rr(ctx, x0, y0 + st.radius * u * 0.6, bar, h - st.radius * u * 1.2, bar / 2);
  ctx.fill();

  const left = x0 + p + bar;
  const right = x0 + w - p;
  let y = y0 + p;
  const sep = () => {
    ctx.fillStyle = hexA(st.text, 0.1);
    ctx.fillRect(left, y + 8 * u, right - left, Math.max(1, u));
    y += 18 * u;
  };
  let first = true;
  const next = () => { if (!first) sep(); first = false; };

  if (headH) {
    next();
    const mid = y + headH / 2;
    if (logo) ctx.drawImage(logo.img, left, mid - logo.h / 2, logo.w, logo.h);
    else if (whoName || whoKart) {
      ctx.textAlign = 'left';
      ctx.font = LF(22, 700);
      const nw = whoName ? ctx.measureText(whoName).width + 12 * u : 0;
      ctx.fillStyle = st.text;
      if (whoName) ctx.fillText(whoName, left, mid + 8 * u);
      if (whoKart) { ctx.font = whoName ? LF(16) : LF(22, 700); ctx.fillStyle = whoName ? st.muted : st.text; ctx.fillText(whoKart, left + nw, mid + 8 * u); }
    }
    // Справа: позиция и номер круга.
    let rx = right;
    if (sh.lapNo) {
      ctx.font = NF(20);
      ctx.fillStyle = st.text;
      const lw = drawNum(ctx, c.lapText, rx, mid + 8 * u, 'right');
      rx -= lw + 8 * u;
      ctx.font = LF(16);
      ctx.fillStyle = st.muted;
      ctx.textAlign = 'right';
      ctx.fillText(c.L.lap, rx, mid + 7 * u);
      rx -= ctx.measureText(c.L.lap).width + 16 * u;
    }
    if (sh.pos && c.pos) {
      ctx.font = NF(18);
      const pw = textW(ctx, NF(18), c.pos) + 16 * u;
      ctx.fillStyle = st.accent;
      rr(ctx, rx - pw, mid - 14 * u, pw, 28 * u, 8 * u);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(c.pos, rx - pw / 2, mid + 7 * u);
    }
    y += headH;
    if (nameLine) {
      ctx.font = LF(20, 600);
      ctx.fillStyle = st.text;
      ctx.textAlign = 'left';
      const nw = whoName ? ctx.measureText(whoName).width + 12 * u : 0;
      if (whoName) ctx.fillText(whoName, left, y + 20 * u);
      if (whoKart) {
        ctx.font = whoName ? LF(16) : LF(20, 600);
        ctx.fillStyle = whoName ? st.muted : st.text;
        ctx.fillText(whoKart, left + nw, y + 20 * u);
      }
      y += 26 * u;
    }
  }

  if (curH) {
    next();
    ctx.font = LF(18);
    ctx.fillStyle = st.muted;
    ctx.textAlign = 'left';
    ctx.fillText(c.L.current, left, y + 16 * u);
    ctx.fillStyle = st.text;
    ctx.font = NF(64);
    if (c.curIsText) { ctx.textAlign = 'left'; ctx.fillText(c.cur, left, y + 22 * u + 60 * u); }
    else drawNum(ctx, c.cur, left, y + 22 * u + 60 * u, 'left');
    y += curH;
  }

  if (colsOn) {
    next();
    const cols = [];
    if (sh.last) cols.push('last');
    if (sh.best) cols.push('best');
    const cw = cols.length === 2 ? (right - left - colGap) / 2 : right - left;
    cols.forEach((k, ci) => {
      const cx = left + ci * (cw + colGap);
      if (k === 'last' && c.flashK > 0) {
        ctx.fillStyle = hexA(c.flashColor, 0.22 * c.flashK);
        rr(ctx, cx - 10 * u, y - 6 * u, cw + 20 * u, colsH + 6 * u, 12 * u);
        ctx.fill();
      }
      ctx.textAlign = 'left';
      ctx.font = LF(16);
      ctx.fillStyle = st.muted;
      ctx.fillText(k === 'last' ? c.L.last : c.L.best, cx, y + 16 * u);
      ctx.font = NF(30);
      ctx.fillStyle = k === 'last' ? c.lastColor : st.text;
      drawNum(ctx, k === 'last' ? c.last : c.best, cx, y + 22 * u + 32 * u, 'left');
      ctx.font = LF(16, 600);
      if (k === 'last') {
        if (c.newBest) { ctx.fillStyle = st.record; ctx.fillText(c.L.newBest, cx, y + 22 * u + 34 * u + 22 * u); }
        else if (sh.delta && c.deltaText) { ctx.fillStyle = c.deltaColor; ctx.font = NF(16); drawNum(ctx, c.deltaText, cx, y + 22 * u + 34 * u + 22 * u, 'left'); }
      } else if (sh.bestLap && c.bestLap) {
        ctx.fillStyle = st.muted;
        ctx.font = LF(16);
        ctx.fillText(c.bestLap, cx, y + 22 * u + 34 * u + 22 * u);
      }
    });
    y += colsH;
  }

  if (heatH) {
    next();
    ctx.textAlign = 'left';
    ctx.font = LF(16);
    ctx.fillStyle = st.muted;
    ctx.fillText(c.L.heatBest, left, y + 26 * u);
    ctx.textAlign = 'right';
    ctx.fillStyle = st.text;
    ctx.font = NF(20);
    const bw = drawNum(ctx, c.heatBest, right, y + 26 * u, 'right');
    ctx.font = LF(16);
    ctx.fillStyle = st.muted;
    ctx.fillText(c.heatBestName, right - bw - 10 * u, y + 26 * u);
    y += heatH;
  }
}

// ---- Полоса ----
function drawBar(ctx, W, H, u, st, c, assets) {
  const sh = st.show;
  const p = 26 * u;
  const h = 96 * u;
  const gap = 30 * u;
  const NF = (px) => font(st.numWeight, px * u, st.numFont);
  const LF = (px, w) => font(w || st.labelWeight, px * u, st.labelFont);
  const segs = [];
  const logo = sh.logo ? logoSize(assets, 26 * u) : null;
  const whoText = [sh.name && c.name ? c.name : '', sh.kart && c.kart ? c.kart : ''].filter(Boolean).join('  ');
  if (logo || whoText) {
    const nw = whoText ? textW(ctx, LF(logo ? 18 : 22, 700), whoText) : 0;
    segs.push({ k: 'who', w: Math.max(logo ? logo.w : 0, nw) });
  }
  if (sh.lapNo || (sh.pos && c.pos)) {
    ctx.font = NF(30);
    const lw = numWidth(ctx, c.n + '/' + c.n);
    segs.push({ k: 'lap', w: Math.max(lw + (sh.pos && c.pos ? textW(ctx, NF(22), c.pos) + 26 * u : 0), textW(ctx, LF(16), c.L.lap)) });
  }
  if (sh.current) {
    ctx.font = NF(46);
    segs.push({ k: 'cur', w: Math.max(numWidth(ctx, c.template), textW(ctx, NF(46), st.lower ? 'финиш' : 'ФИНИШ')) });
  }
  ctx.font = NF(30);
  const small = Math.max(numWidth(ctx, c.template3), 120 * u);
  if (sh.last) segs.push({ k: 'last', w: small + (sh.delta ? textW(ctx, NF(18), '+0.000') + 14 * u : 0) });
  if (sh.best) segs.push({ k: 'best', w: Math.max(small, textW(ctx, LF(16), c.L.best + '  ' + c.bestLap)) });
  if (sh.heatBest && c.heatBest) segs.push({ k: 'heat', w: Math.max(small, textW(ctx, LF(16), c.L.heatBest + ' ' + c.heatBestName)) });
  if (!segs.length) return;
  const w = p * 2 + 6 * u + segs.reduce((a, s) => a + s.w, 0) + gap * (segs.length - 1);
  const pos = place(W, H, w, h, st);
  drawPanel(ctx, pos.x, pos.y, w, h, u, st, c.newBest ? c.flashK : 0);
  ctx.fillStyle = st.accent;
  rr(ctx, pos.x, pos.y + st.radius * u * 0.5, 6 * u, h - st.radius * u, 3 * u);
  ctx.fill();
  let x = pos.x + p + 6 * u;
  const top = pos.y + 36 * u;
  const base = pos.y + h - 24 * u;
  segs.forEach((s, i) => {
    if (i) {
      ctx.fillStyle = hexA(st.text, 0.12);
      ctx.fillRect(x - gap / 2, pos.y + 20 * u, Math.max(1, u), h - 40 * u);
    }
    ctx.textAlign = 'left';
    const label = (t) => { ctx.font = LF(16); ctx.fillStyle = st.muted; ctx.fillText(t, x, top); };
    if (s.k === 'who') {
      if (logo) ctx.drawImage(logo.img, x, pos.y + 18 * u, logo.w, logo.h);
      if (whoText) {
        ctx.font = LF(logo ? 18 : 22, 700);
        ctx.fillStyle = st.text;
        ctx.fillText(whoText, x, logo ? base : pos.y + h / 2 + 8 * u);
      }
    } else if (s.k === 'lap') {
      label(c.L.lap);
      ctx.font = NF(30);
      ctx.fillStyle = st.text;
      const lw = sh.lapNo ? drawNum(ctx, c.lapText, x, base, 'left') : 0;
      if (sh.pos && c.pos) {
        ctx.font = NF(22);
        const pw = ctx.measureText(c.pos).width + 14 * u;
        const px = x + lw + (lw ? 12 * u : 0);
        ctx.fillStyle = st.accent;
        rr(ctx, px, base - 26 * u, pw, 32 * u, 8 * u);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(c.pos, px + 7 * u, base - 2 * u);
      }
    } else if (s.k === 'cur') {
      label(c.L.current);
      ctx.font = NF(46);
      ctx.fillStyle = st.text;
      if (c.curIsText) ctx.fillText(c.cur, x, base + 4 * u);
      else drawNum(ctx, c.cur, x, base + 4 * u, 'left');
    } else if (s.k === 'last') {
      if (c.flashK > 0) {
        ctx.fillStyle = hexA(c.flashColor, 0.22 * c.flashK);
        rr(ctx, x - 12 * u, pos.y + 10 * u, s.w + 24 * u, h - 20 * u, 12 * u);
        ctx.fill();
      }
      label(c.newBest ? c.L.newBest : c.L.last);
      ctx.font = NF(30);
      ctx.fillStyle = c.lastColor;
      const lw = drawNum(ctx, c.last, x, base, 'left');
      if (sh.delta && c.deltaText) {
        ctx.font = NF(18);
        ctx.fillStyle = c.deltaColor;
        drawNum(ctx, c.deltaText, x + lw + 12 * u, base, 'left');
      }
    } else if (s.k === 'best') {
      label(c.L.best + (sh.bestLap && c.bestLap ? '  ·  ' + c.bestLap : ''));
      ctx.font = NF(30);
      ctx.fillStyle = st.text;
      drawNum(ctx, c.best, x, base, 'left');
    } else if (s.k === 'heat') {
      label(c.L.heatBest + ' · ' + c.heatBestName);
      ctx.font = NF(30);
      ctx.fillStyle = st.text;
      drawNum(ctx, c.heatBest, x, base, 'left');
    }
    x += s.w + gap;
  });
}

// ---- Только цифры ----
function drawMini(ctx, W, H, u, st, c, assets) {
  const sh = st.show;
  const p = 18 * u;
  const NF = (px) => font(st.numWeight, px * u, st.numFont);
  const LF = (px, w) => font(w || st.labelWeight, px * u, st.labelFont);
  const right = (st.anchor || 'bl')[1] === 'r';
  const center = (st.anchor || 'bl')[1] === 'c';
  const align = right ? 'right' : center ? 'center' : 'left';
  ctx.font = NF(84);
  const bigW = Math.max(numWidth(ctx, c.template), textW(ctx, NF(84), st.lower ? 'финиш' : 'ФИНИШ'));
  const topLine = [sh.lapNo ? c.L.lap + ' ' + c.lapText : '', sh.pos && c.pos ? c.pos : '', sh.name && c.name ? c.name : '', sh.kart && c.kart ? c.kart : ''].filter(Boolean).join('   ');
  const parts = [];
  if (sh.last) parts.push({ label: c.L.last, val: c.last, color: c.lastColor, extra: c.newBest ? c.L.newBest : sh.delta ? c.deltaText : '', extraColor: c.newBest ? st.record : c.deltaColor });
  if (sh.best) parts.push({ label: c.L.best, val: c.best, color: st.text, extra: sh.bestLap ? c.bestLap : '', extraColor: st.muted });
  ctx.font = NF(26);
  const partW = (pt) => {
    const lw = textW(ctx, LF(16), pt.label);
    ctx.font = NF(26);
    const vw = numWidth(ctx, pt.val.length > c.template3.length ? pt.val : c.template3);
    const ew = pt.extra ? 10 * u + Math.max(textW(ctx, LF(16, 600), pt.extra), (ctx.font = NF(16), numWidth(ctx, '+0.000'))) : 0;
    return lw + 10 * u + vw + ew;
  };
  const rowW = parts.reduce((a, pt) => a + partW(pt), 0) + Math.max(0, parts.length - 1) * 26 * u;
  const logo = sh.logo ? logoSize(assets, 22 * u) : null;
  const w = Math.max(sh.current ? bigW : 0, rowW, topLine ? textW(ctx, LF(18, 600), topLine) : 0, logo ? logo.w : 0) + p * 2;
  const h = p * 2 + (logo ? 32 * u : 0) + (topLine ? 30 * u : 0) + (sh.current ? 88 * u : 0) + (parts.length ? 40 * u : 0);
  const pos = place(W, H, w, h, st);
  if (st.panelAlpha > 0 || st.blur > 0) drawPanel(ctx, pos.x, pos.y, w, h, u, st, c.newBest ? c.flashK : 0);
  const ax = align === 'right' ? pos.x + w - p : align === 'center' ? pos.x + w / 2 : pos.x + p;
  let y = pos.y + p;
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 12 * u;
  ctx.shadowOffsetY = 2 * u;
  if (logo) {
    const lx = align === 'right' ? ax - logo.w : align === 'center' ? ax - logo.w / 2 : ax;
    ctx.drawImage(logo.img, lx, y, logo.w, logo.h);
    y += 32 * u;
  }
  if (topLine) {
    ctx.font = LF(18, 600);
    ctx.fillStyle = st.muted;
    ctx.textAlign = align;
    ctx.fillText(topLine, ax, y + 20 * u);
    y += 30 * u;
  }
  if (sh.current) {
    ctx.font = NF(84);
    ctx.fillStyle = st.text;
    if (c.curIsText) { ctx.textAlign = align; ctx.fillText(c.cur, ax, y + 78 * u); }
    else drawNum(ctx, c.cur, ax, y + 78 * u, align);
    y += 88 * u;
  }
  if (parts.length) {
    let x = align === 'right' ? ax - rowW : align === 'center' ? ax - rowW / 2 : ax;
    const by = y + 30 * u;
    parts.forEach((pt) => {
      ctx.font = NF(26);
      const pw = partW(pt);
      ctx.textAlign = 'left';
      ctx.font = LF(16);
      ctx.fillStyle = st.muted;
      ctx.fillText(pt.label, x, by);
      let cx = x + ctx.measureText(pt.label).width + 10 * u;
      ctx.font = NF(26);
      ctx.fillStyle = pt.color;
      cx += drawNum(ctx, pt.val, cx, by, 'left') + 10 * u;
      if (pt.extra) {
        ctx.fillStyle = pt.extraColor;
        if (/^[+−0-9]/.test(pt.extra)) { ctx.font = NF(16); drawNum(ctx, pt.extra, cx, by, 'left'); }
        else { ctx.font = LF(16, 600); ctx.fillText(pt.extra, cx, by); }
      }
      x += pw + 26 * u;
    });
  }
}
