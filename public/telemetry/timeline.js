// Таймлайн под видео: шкала времени, круги отрезками, метки пересечения линии и курсор воспроизведения.
// Метки можно тянуть мышью или пальцем, колесо мыши приближает, Shift+колесо листает.
import { fmtLap, fmtClock } from './laps.js?v=dev';

const C = {
  bg: '#141416', lane: '#1d1d20', lane2: '#242428', line: '#2c2c30', text: '#f4f4f5', hint: '#8d8d95',
  orange: '#ff5a00', best: 'rgba(255,90,0,0.28)', off: 'rgba(255,255,255,0.05)',
};

export class Timeline {
  // get() → { duration, time, laps, markers, bestIdx, joints, trim: { a, b } };
  // on: { seek(t), moveEdge(idx, t), moveMarker(idx, t), moveTrim('a' | 'b', t), dragEnd() }
  constructor(canvas, get, on) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.get = get;
    this.on = on;
    this.from = 0;
    this.to = 0;
    this.drag = null;
    this.hover = -1;
    this.dpr = 1;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.c.width = Math.max(1, Math.round(r.width * this.dpr));
    this.c.height = Math.max(1, Math.round(r.height * this.dpr));
    this.draw();
  }

  setView(from, to) {
    const d = this.get().duration || 0;
    const min = Math.min(d, 2);
    let len = Math.max(min, to - from);
    if (len > d) len = d;
    from = Math.max(0, Math.min(from, d - len));
    this.from = from;
    this.to = from + len;
    this.draw();
    if (this.onView) this.onView(this.from, this.to);
  }
  zoomBy(k, at) {
    const d = this.get().duration || 0;
    if (!d) return;
    if (at == null) at = (this.from + this.to) / 2;
    const len = Math.min(d, Math.max(2, (this.to - this.from) * k));
    const f = (at - this.from) / (this.to - this.from || 1);
    this.setView(at - len * f, at - len * f + len);
  }
  // Держит курсор в поле зрения при воспроизведении.
  follow(t) {
    if (t > this.to || t < this.from) {
      const len = this.to - this.from;
      this.setView(t - len * 0.1, t - len * 0.1 + len);
    }
  }

  x(t) { return ((t - this.from) / (this.to - this.from || 1)) * this.w; }
  t(x) { return this.from + (x / this.w) * (this.to - this.from); }

  // Ручки обрезки: начало (a) и конец (b) сохраняемого видео.
  hitTrim(px) {
    const tr = this.get().trim || {};
    let best = null;
    let bd = 9;
    ['a', 'b'].forEach((k) => {
      if (tr[k] == null) return;
      const d = Math.abs(this.x(tr[k]) - px);
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  }
  // Что под курсором: метка круга, ручка обрезки или ничего. В полосе шкалы ручки обрезки важнее.
  hitAny(p) {
    if (p.y <= 22) {
      const k = this.hitTrim(p.x);
      return k ? { kind: 'trim', k } : null;
    }
    const m = this.hitMarker(p.x);
    if (m >= 0) return { kind: 'marker', idx: m };
    const k = this.hitTrim(p.x);
    return k ? { kind: 'trim', k } : null;
  }

  hitMarker(px) {
    const { markers } = this.get();
    let best = -1;
    let bd = 9;
    markers.forEach((m, i) => {
      const d = Math.abs(this.x(m) - px);
      // Края (старт и финиш) хватаются легче.
      const lim = i === 0 || i === markers.length - 1 ? 12 : 8;
      if (d < lim && d < bd + (i === 0 || i === markers.length - 1 ? 4 : 0)) { bd = d; best = i; }
    });
    return best;
  }

  bind() {
    const c = this.c;
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('pointerdown', (e) => {
      if (!this.get().duration) return;
      c.setPointerCapture(e.pointerId);
      const p = pos(e);
      this.drag = this.hitAny(p) || { kind: 'seek' };
      if (this.drag.kind === 'seek') this.on.seek(Math.max(0, Math.min(this.get().duration, this.t(p.x))));
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (!this.drag) {
        const h = this.hitAny(p);
        const hv = h ? (h.kind === 'marker' ? h.idx : h.k) : -1;
        if (hv !== this.hover) { this.hover = hv; this.draw(); }
        c.style.cursor = h ? 'ew-resize' : 'pointer';
        return;
      }
      const t = Math.max(0, Math.min(this.get().duration, this.t(p.x)));
      if (this.drag.kind === 'seek') this.on.seek(t);
      else if (this.drag.kind === 'trim') {
        this.on.moveTrim(this.drag.k, t);
        this.on.seek(t, true);
      } else {
        const { markers } = this.get();
        if (this.drag.idx === 0 || this.drag.idx === markers.length - 1) this.on.moveEdge(this.drag.idx, t);
        else this.on.moveMarker(this.drag.idx, t);
        this.on.seek(t, true);
      }
    });
    const end = () => {
      if (this.drag && this.drag.kind !== 'seek' && this.on.dragEnd) this.on.dragEnd();
      this.drag = null;
      this.draw();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!this.drag && this.hover !== -1) { this.hover = -1; this.draw(); } });
    c.addEventListener('wheel', (e) => {
      if (!this.get().duration) return;
      e.preventDefault();
      const p = pos(e);
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dt = ((e.deltaX || e.deltaY) / this.w) * (this.to - this.from);
        this.setView(this.from + dt, this.to + dt);
      } else {
        this.zoomBy(Math.exp(e.deltaY * 0.0015), this.t(p.x));
      }
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const { markers } = this.get();
      const t = this.t(pos(e).x);
      for (let i = 0; i < markers.length - 1; i++) {
        if (t >= markers[i] && t < markers[i + 1]) { this.setView(markers[i] - 1, markers[i + 1] + 1); return; }
      }
    });
  }

  draw() {
    const g = this.ctx;
    const { duration, time, laps, markers, bestIdx, joints, trim } = this.get();
    const W = this.w;
    const H = this.h;
    if (!W || !H) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    if (!duration) {
      g.fillStyle = C.hint;
      g.font = '500 13px Onest, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('Здесь появится таймлайн видео', W / 2, H / 2 + 4);
      return;
    }
    if (this.to <= this.from) { this.from = 0; this.to = duration; }
    const top = 26;
    const laneH = H - top - 10;

    // Шкала: шаг подбирается под масштаб.
    const span = this.to - this.from;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    const step = steps.find((s) => (s / span) * W >= 70) || 3600;
    g.font = '500 11px Onest, system-ui, sans-serif';
    g.textAlign = 'left';
    for (let t = Math.ceil(this.from / step) * step; t <= this.to; t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      g.fillStyle = C.line;
      g.fillRect(x, 16, 1, 6);
      g.fillStyle = C.hint;
      g.fillText(fmtClock(t, step < 1 ? 1 : 0).replace(/^00:/, '0:'), x + 4, 13);
    }
    g.fillStyle = C.lane;
    g.fillRect(0, top, W, laneH);

    // Круги.
    const n = laps.length;
    if (markers.length === n + 1 && n) {
      for (let i = 0; i < n; i++) {
        const x1 = this.x(markers[i]);
        const x2 = this.x(markers[i + 1]);
        if (x2 < 0 || x1 > W) continue;
        g.fillStyle = i === bestIdx ? C.best : i % 2 ? C.lane2 : C.lane;
        g.fillRect(x1, top, x2 - x1, laneH);
        if (laps[i].on === false) {
          // Неучитываемый круг (пит-стоп) — штриховка.
          g.save();
          g.beginPath();
          g.rect(x1, top, x2 - x1, laneH);
          g.clip();
          g.strokeStyle = C.off;
          g.lineWidth = 6;
          for (let k = x1 - laneH; k < x2; k += 14) { g.beginPath(); g.moveTo(k, top + laneH); g.lineTo(k + laneH, top); g.stroke(); }
          g.restore();
        }
        const w = x2 - x1;
        if (w > 26) {
          g.textAlign = 'center';
          g.fillStyle = i === bestIdx ? C.orange : C.text;
          g.font = '700 12px Unbounded, Onest, system-ui, sans-serif';
          const cx = Math.max(x1 + 14, Math.min(x2 - 14, (x1 + x2) / 2));
          g.fillText(String(i + 1), cx, top + laneH / 2 - (w > 70 ? 2 : -4));
          if (w > 70) {
            g.font = '500 11px Onest, system-ui, sans-serif';
            g.fillStyle = C.hint;
            g.fillText(fmtLap(laps[i].t), cx, top + laneH / 2 + 14);
          }
        }
      }
      // Метки.
      markers.forEach((m, i) => {
        const x = Math.round(this.x(m)) + 0.5;
        if (x < -10 || x > W + 10) return;
        const edge = i === 0 || i === n;
        const hot = i === this.hover || (this.drag && this.drag.idx === i);
        g.fillStyle = edge ? C.orange : hot ? C.text : 'rgba(255,255,255,0.55)';
        g.fillRect(x - (edge || hot ? 1 : 0.5), top - 4, edge || hot ? 2 : 1, laneH + 8);
        if (edge) {
          // Флажок старта или финиша.
          g.beginPath();
          const dir = i === 0 ? 1 : -1;
          g.moveTo(x, top - 4);
          g.lineTo(x + dir * 10, top + 1);
          g.lineTo(x, top + 6);
          g.closePath();
          g.fill();
        } else {
          g.beginPath();
          g.arc(x, top + laneH + 2, hot ? 4 : 3, 0, Math.PI * 2);
          g.fill();
        }
      });
    } else if (markers.length) {
      const x = Math.round(this.x(markers[0])) + 0.5;
      g.fillStyle = C.orange;
      g.fillRect(x - 1, top - 4, 2, laneH + 8);
    }

    // Стыки частей видео (если камера разрезала запись).
    (joints || []).forEach((j) => {
      const x = Math.round(this.x(j)) + 0.5;
      if (x < 0 || x > W) return;
      g.fillStyle = 'rgba(255,255,255,0.35)';
      for (let y = top; y < top + laneH; y += 6) g.fillRect(x - 0.5, y, 1, 3);
      g.fillStyle = C.hint;
      g.font = '500 10px Onest, system-ui, sans-serif';
      g.textAlign = 'left';
      g.fillText('стык', x + 3, top + laneH - 4);
    });

    // Обрезка: всё, что не попадёт в готовое видео, затемнено.
    const tr = trim || {};
    if (tr.a != null || tr.b != null) {
      const xa = tr.a != null ? this.x(tr.a) : -1;
      const xb = tr.b != null ? this.x(tr.b) : W + 1;
      g.fillStyle = 'rgba(9,9,10,0.72)';
      if (xa > 0) g.fillRect(0, 0, Math.min(W, xa), H);
      if (xb < W) g.fillRect(Math.max(0, xb), 0, W - Math.max(0, xb), H);
      [['a', xa], ['b', xb]].forEach(([k, x]) => {
        if (tr[k] == null || x < -8 || x > W + 8) return;
        const hot = this.hover === k || (this.drag && this.drag.k === k);
        x = Math.round(x);
        g.fillStyle = hot ? '#ffffff' : '#e8e8ea';
        g.fillRect(x - 1.5, 0, 3, H);
        // Скоба: у начала открыта вправо, у конца — влево.
        const dir = k === 'a' ? 1 : -1;
        g.fillRect(dir > 0 ? x - 1.5 : x - 8.5, 0, 10, 3);
        g.fillRect(dir > 0 ? x - 1.5 : x - 8.5, H - 3, 10, 3);
        g.font = '600 10px Onest, system-ui, sans-serif';
        g.textAlign = dir > 0 ? 'left' : 'right';
        g.fillText(k === 'a' ? 'начало' : 'конец', x + dir * 6, 14);
      });
    }

    // Курсор воспроизведения.
    const px = Math.round(this.x(time)) + 0.5;
    if (px >= -2 && px <= W + 2) {
      g.fillStyle = '#ffffff';
      g.fillRect(px - 1, 0, 2, H);
      g.beginPath();
      g.moveTo(px - 6, 0);
      g.lineTo(px + 6, 0);
      g.lineTo(px, 8);
      g.closePath();
      g.fill();
    }
  }
}
