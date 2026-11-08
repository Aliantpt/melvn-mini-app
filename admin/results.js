  // ---- Результаты тренировки ----
  // Админ вставляет ссылки на заезды с timing.batyrshin.name, отмечает пилотов команды,
  // панель рисует для каждого картинку с результатами, и бот присылает её пилоту.
  // Этот кусок вставляется в admin.html при сборке и пользуется его общими функциями.
  const TIMING_NICK = 'Ник в хронометраже';
  const res = { links: '', title: '', heats: [], karts: {}, picked: {}, loading: false, sending: false };
  const timeFmt = (s) => {
    if (s == null || !isFinite(s)) return '—';
    if (s < 60) return s.toFixed(3);
    const m = Math.floor(s / 60);
    return m + ':' + (s - m * 60).toFixed(3).padStart(6, '0');
  };
  const gapFmt = (d) => (d == null || !isFinite(d) ? '—' : Math.abs(d) < 0.0005 ? '0.000' : (d > 0 ? '+' : '−') + Math.abs(d).toFixed(3));

  // Ники из хронометража у людей: колонка «Ник в хронометраже» (несколько — через запятую).
  function timingNicks(p) {
    return String(p.obj[TIMING_NICK] || '').split(/[,;\n]+/).map((x) => fold(x.trim())).filter(Boolean);
  }
  function personForDriver(name) {
    const n = fold(String(name || '').trim());
    if (!n) return null;
    const list = people().filter((p) => p.active);
    return list.find((p) => timingNicks(p).indexOf(n) >= 0) ||
      list.find((p) => fold(p.name) === n || p.keys.indexOf(n.replace(/^@/, '')) >= 0) || null;
  }

  // Запоминает, кто есть кто: дописывает имя из заезда в «Ник в хронометраже» человека.
  async function linkDriver(name, key) {
    const all = people();
    // Сначала убрать это имя у того, к кому оно было привязано раньше.
    const prev = all.find((p) => timingNicks(p).indexOf(fold(name)) >= 0);
    if (prev && prev.key !== key) {
      const left = String(prev.obj[TIMING_NICK] || '').split(/[,;\n]+/).map((x) => x.trim()).filter((x) => x && fold(x) !== fold(name));
      if (!(await replace('Люди', [prev.raw], [Object.assign({}, prev.obj, { [TIMING_NICK]: left.join(', ') })], 'Привязка снята'))) return;
    }
    if (!key) return render();
    const p = people().find((x) => x.key === key);
    if (!p) return;
    const list = String(p.obj[TIMING_NICK] || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
    if (list.some((x) => fold(x) === fold(name))) return render();
    list.push(name);
    await replace('Люди', [p.raw], [Object.assign({}, p.obj, { [TIMING_NICK]: list.join(', ') })], '«' + name + '» — это ' + p.name);
  }

  // Тренировки для подписи на картинке: открытые и назначенные, свежие сверху.
  function trainingTitles() {
    const t = today();
    const out = [];
    trainings('Тренировки').concat(trainings('Архив тренировок')).forEach((x) => out.push({ date: x.date, title: x.title, track: x.obj['Трасса'] || '' }));
    groupEvents('События').concat(groupEvents('Архив событий')).filter((g) => /трен/i.test(g.base['Тип'])).forEach((g) => out.push({ date: g.date, title: g.title, track: g.base['Трасса'] || '' }));
    return out.filter((x) => x.date && x.date <= t).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 40);
  }

  function resultsView() {
    const titles = trainingTitles();
    const sel = '<select class="input" id="r-title" style="min-width:240px"><option value="">Подпись: только трасса и дата</option>' +
      titles.map((x) => { const v = x.title + ' · ' + fmtDate(x.date); return '<option' + (v === res.title ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select>';
    let html = '<h1>Результаты тренировки</h1>' +
      '<div class="hint" style="margin:-6px 0 14px">Вставьте ссылки на заезды с timing.batyrshin.name, отметьте пилотов, и бот пришлёт каждому PDF с его результатами: страница на каждый заезд.</div>' +
      '<div class="box" style="margin-top:0"><textarea class="input" id="r-links" placeholder="https://timing.batyrshin.name/tracks/drive/heats/123456&#10;по одной ссылке в строке">' + esc(res.links) + '</textarea>' +
      '<div class="bar" style="margin:10px 0 0">' + sel + '<div class="spacer"></div><button class="btn" id="r-load"' + (res.loading ? ' disabled' : '') + '>' + (res.loading ? 'Загружаю…' : 'Загрузить заезды') + '</button></div></div>';
    if (!res.heats.length) return html;
    const team = people().filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    res.heats.forEach((h, hi) => {
      html += '<div class="box"><h3>Заезд ' + (hi + 1) + ' · ' + esc(h.name || '') + '<span style="text-transform:none;font-weight:500;letter-spacing:0">' +
        esc([h.track, fmtDate(h.date), h.time].filter(Boolean).join(' · ')) + '</span></h3>' +
        '<div class="hint" style="margin-bottom:6px">Отметьте пилотов, которым отправить результаты. Если имя из заезда не узнано, выберите человека — панель запомнит.</div>';
      h.drivers.forEach((d, di) => {
        const p = personForDriver(d.name);
        const id = hi + ':' + di;
        html += '<div class="row-line"><label class="check" style="min-width:24px"><input type="checkbox" data-pick="' + id + '"' + (res.picked[id] && p ? ' checked' : '') + (p ? '' : ' disabled') + '></label>' +
          '<div style="width:34px;color:var(--hint)">P' + d.pos + '</div>' +
          '<div class="grow"><b>' + esc(d.name) + '</b> <span class="hint">карт ' + esc(d.kart) + ' · лучший ' + timeFmt(d.best) + '</span></div>' +
          '<select class="input" data-link="' + esc(d.name) + '" style="max-width:220px"><option value="">не из команды</option>' +
          team.map((t) => '<option value="' + esc(t.key) + '"' + (p && p.key === t.key ? ' selected' : '') + '>' + esc(t.name) + '</option>').join('') + '</select></div>';
      });
      html += '</div>';
    });
    const n = picks().length;
    html += '<div class="box"><h3>PDF для пилотов' + (n ? ' (' + new Set(picks().map((x) => x.person.key)).size + ')' : '') + '</h3><div id="r-previews" class="previews">' +
      (n ? '' : '<div class="hint">Отметьте хотя бы одного пилота.</div>') + '</div>' +
      '<div class="err" id="r-err"></div><div class="bar" style="margin:10px 0 0"><div class="spacer"></div>' +
      '<label class="btn ghost small" style="cursor:pointer">' + (hasTeamFont() ? 'Шрифт команды выбран' : 'Шрифт команды (.otf)') + '<input type="file" id="r-font" accept=".otf,.ttf,.woff,.woff2" hidden></label>' +
      '<button class="btn" id="r-send" title="Каждый пилот получит один PDF со всеми своими заездами"' + (!n || res.sending ? ' disabled' : '') + '>' + (res.sending ? 'Отправляю…' : 'Отправить пилотам') + '</button></div></div>';
    return html;
  }

  // Выбранные пары «заезд — пилот», у которых есть человек в «Людях».
  function picks() {
    const out = [];
    res.heats.forEach((h, hi) => h.drivers.forEach((d, di) => {
      const p = personForDriver(d.name);
      if (res.picked[hi + ':' + di] && p) out.push({ heat: h, heatNo: hi + 1, driver: d, person: p });
    }));
    return out;
  }

  function bindResults() {
    const links = $('#r-links');
    if (!links) return;
    links.oninput = () => (res.links = links.value);
    $('#r-title').onchange = (e) => { res.title = e.target.value; drawPreviews(); };
    $('#r-load').onclick = loadHeats;
    $$('[data-pick]').forEach((b) => (b.onchange = () => { res.picked[b.dataset.pick] = b.checked; render(); }));
    $$('[data-link]').forEach((s) => (s.onchange = () => linkDriver(s.dataset.link, s.value)));
    const fontInput = $('#r-font');
    if (fontInput) fontInput.onchange = () => {
      const f = fontInput.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try { localStorage.setItem(FONT_KEY, rd.result); } catch (e) { return toast('Не удалось сохранить шрифт в браузере', true); }
        fontReady = null;
        toast('Шрифт сохранён в этом браузере');
        render();
      };
      rd.readAsDataURL(f);
    };
    const send = $('#r-send');
    if (send) send.onclick = sendResults;
    drawPreviews();
  }

  async function fetchTiming(url) {
    const r = await call('admin_timing', url);
    if (r && r.error) {
      throw new Error(r.error === 'bad_url' ? 'Это не ссылка на заезд timing.batyrshin.name: ' + url : 'Сайт хронометража не ответил (' + r.error + ')');
    }
    return r;
  }

  async function loadHeats() {
    const urls = res.links.split(/\s+/).map((x) => x.trim()).filter(Boolean);
    if (!urls.length) return toast('Вставьте хотя бы одну ссылку', true);
    res.loading = true;
    render();
    const heats = [];
    try {
      for (const u of urls) {
        const r = await fetchTiming(u);
        const h = parseHeat(r.html, r.url);
        if (!h.drivers.length) throw new Error('Не нашёл результатов на странице ' + u);
        heats.push(h);
      }
      heats.sort((a, b) => ((a.date + a.time) < (b.date + b.time) ? -1 : 1));
      res.heats = heats;
      res.picked = {};
      // Сразу отмечаем всех узнанных пилотов команды.
      heats.forEach((h, hi) => h.drivers.forEach((d, di) => { if (personForDriver(d.name)) res.picked[hi + ':' + di] = true; }));
    } catch (e) {
      toast(e && e.message ? e.message : String(e), true);
    }
    res.loading = false;
    render();
  }

  // ---- Разбор страниц timing.batyrshin.name ----
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const pad2 = (n) => String(n).padStart(2, '0');
  // «37.322» или «1:09.311» → секунды.
  function lapSec(t) {
    const m = String(t || '').trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)/);
    return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : NaN;
  }
  const cleanText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  // Страница заезда: таблица heat-result, столбцы — пилоты в порядке финиша.
  function parseHeat(html, url) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const m = String(url).match(/\/tracks\/([^/]+)\/heats\/(\d+)/) || [];
    const h = { url, track: m[1] || '', id: m[2] || '', name: cleanText(doc.querySelector('title')), date: '', time: '', drivers: [] };
    const when = cleanText(doc.querySelector('h4 small')).match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/);
    if (when && MON[when[2].toLowerCase()]) {
      h.date = when[3] + '-' + pad2(MON[when[2].toLowerCase()]) + '-' + pad2(when[1]);
      h.time = pad2(when[4]) + ':' + when[5];
    }
    const table = doc.querySelector('table.heat-result');
    if (!table) return h;
    const rowBy = (label) => Array.prototype.find.call(table.querySelectorAll('tr'), (tr) => cleanText(tr.querySelector('th')) === label);
    const cells = (tr) => (tr ? Array.prototype.slice.call(tr.children, 1) : []);
    const names = cells(rowBy('Driver'));
    const karts = cells(rowBy('Kart'));
    const foot = (label) => cells(rowBy(label)).map((c) => cleanText(c));
    const best = foot('Best');
    const avg = foot('Avg');
    const dev = foot('Dev');
    const gap = foot('Gap');
    names.forEach((th, i) => {
      const a = th.querySelector('a');
      h.drivers.push({
        name: cleanText(th),
        driverId: a ? (a.getAttribute('href').match(/drivers\/(\d+)/) || [])[1] || '' : '',
        kart: cleanText(karts[i]),
        pos: i + 1,
        best: lapSec(best[i]), avg: lapSec(avg[i]), dev: lapSec(dev[i]), gap: gap[i] || '',
        laps: [],
      });
    });
    table.querySelectorAll('tbody tr').forEach((tr) => {
      cells(tr).forEach((td, i) => {
        // Время круга — текст ячейки до вложенных позиций и отрывов.
        const own = Array.prototype.filter.call(td.childNodes, (n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
        const t = lapSec(own);
        if (h.drivers[i] && isFinite(t)) h.drivers[i].laps.push(t);
      });
    });
    h.drivers.forEach((d) => {
      if (!isFinite(d.best) && d.laps.length) d.best = Math.min.apply(null, d.laps);
    });
    return h;
  }

  // Страница карта: лучшие круги этого карта в заездах (кто, когда, какой заезд).
  function parseKart(html, heat) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const year = Number((heat.date || '').slice(0, 4)) || new Date().getFullYear();
    const hm = Number((heat.date || '').slice(5, 7)) || 12;
    const rows = [];
    doc.querySelectorAll('table tbody tr').forEach((tr) => {
      const td = tr.querySelectorAll('td');
      if (td.length < 4) return;
      const heatLink = td[2].querySelector('a');
      const w = cleanText(td[3]).match(/([A-Za-z]{3})\w*\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})/);
      let date = '';
      if (w && MON[w[1].toLowerCase()]) {
        const mo = MON[w[1].toLowerCase()];
        date = (mo - hm > 6 ? year - 1 : year) + '-' + pad2(mo) + '-' + pad2(w[2]);
      }
      rows.push({
        best: lapSec(cleanText(td[0])),
        driver: cleanText(td[1]),
        heatId: heatLink ? (heatLink.getAttribute('href').match(/heats\/(\d+)/) || [])[1] || '' : '',
        heatName: cleanText(td[2]),
        date, time: w ? pad2(w[3]) + ':' + w[4] : '',
      });
    });
    return { rows: rows.filter((r) => isFinite(r.best)) };
  }

  // История карта: страница карта на сайте. Загружается один раз на карт.
  async function kartInfo(h, d) {
    const key = h.track + '/' + d.kart;
    if (!(key in res.karts)) {
      res.karts[key] = null;
      try {
        // За 14 дней, чтобы найти заезды того же дня, даже если результаты отправляют позже.
        const r = await fetchTiming(timingBase(h.url) + '/tracks/' + h.track + '/karts/' + encodeURIComponent(d.kart) + '?m=times&p=14d');
        res.karts[key] = parseKart(r.html, h);
      } catch (e) {
        res.karts[key] = { rows: [], error: e && e.message ? e.message : String(e) };
      }
    }
    return res.karts[key];
  }
  const timingBase = (url) => (String(url).match(/^https?:\/\/[^/]+/) || ['https://timing.batyrshin.name'])[0];

  // Данные одной картинки: пилот, команда в заезде, карт под другими пилотами и отрывы.
  function buildReport(pick, kart) {
    const h = pick.heat;
    const me = pick.driver;
    const withBest = h.drivers.filter((d) => isFinite(d.best));
    const heatBest = withBest.reduce((a, d) => (!a || d.best < a.best ? d : a), null);
    const team = h.drivers.map((d) => ({ d, p: personForDriver(d.name) })).filter((x) => x.p).sort((a, b) => a.d.pos - b.d.pos);
    // Карт под другими пилотами: в тот же день, а если таких заездов нет — за последние две недели.
    const all = (kart && kart.rows ? kart.rows : []).filter((r) => r.heatId !== h.id && fold(r.driver) !== fold(me.name));
    const sameDay = all.filter((r) => r.date === h.date);
    const others = (sameDay.length ? sameDay : all).slice().sort((a, b) => a.best - b.best);
    const kartBest = others.concat([{ driver: me.name, best: me.best, date: h.date }]).filter((r) => isFinite(r.best))
      .reduce((a, r) => (!a || r.best < a.best ? r : a), null);
    return {
      title: res.title || [h.track, fmtDate(h.date)].filter(Boolean).join(' · '),
      titled: !!res.title,
      heatNo: pick.heatNo, heatName: h.name, date: h.date, time: h.time, track: h.track,
      name: pick.person.name, driverName: me.name, pos: me.pos, total: h.drivers.length, kart: me.kart,
      best: me.best, avg: me.avg, laps: me.laps ? me.laps.length : 0,
      heatBest, kartBest,
      team: team.map((x) => ({ name: x.p.name, me: x.d === me, pos: x.d.pos, kart: x.d.kart, best: x.d.best, avg: x.d.avg })),
      kartRows: others.slice(0, 8),
      kartPeriod: sameDay.length || !others.length ? 'в этот день' : 'за 2 недели',
      kartError: kart && kart.error,
    };
  }

  // ---- Картинка ----
  const C = { bg: '#101011', card: '#1b1b1d', line: '#2a2a2d', hint: '#8d8d93', white: '#ffffff', orange: '#ff5a00' };
  let logoImg = null;
  function logo() {
    if (logoImg) return Promise.resolve(logoImg);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve((logoImg = img));
      img.onerror = () => resolve(null);
      img.src = LOGO_SRC;
    });
  }
  // Шрифт команды (Unifix SP) можно один раз выбрать на компьютере, он хранится в этом браузере.
  const FONT_KEY = 'results_font';
  let fontReady = null;
  const hasTeamFont = () => { try { return !!localStorage.getItem(FONT_KEY); } catch (e) { return false; } };
  function loadFont() {
    if (fontReady) return fontReady;
    fontReady = (async () => {
      let data = '';
      try { data = localStorage.getItem(FONT_KEY) || ''; } catch (e) {}
      if (data && window.FontFace) {
        try {
          const f = new FontFace('TeamFont', 'url(' + data + ')');
          await f.load();
          document.fonts.add(f);
          return 'TeamFont';
        } catch (e) {}
      }
      try { await document.fonts.load('700 40px Unbounded'); await document.fonts.load('400 40px Unbounded'); } catch (e) {}
      return 'Unbounded';
    })();
    return fontReady;
  }

  async function drawReport(r) {
    const family = await loadFont();
    const img = await logo();
    const W = 1080;
    const P = 56;
    const rowH = 64;
    const teamH = r.team.length ? 70 + r.team.length * rowH : 0;
    const kartH = 70 + Math.max(1, r.kartRows.length) * rowH;
    const H = 640 + 230 + teamH + 40 + kartH + 110;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    const font = (w, s) => (g.font = w + ' ' + s + 'px ' + family + ', "Segoe UI", sans-serif');
    const text = (t, x, y, color, align) => { g.fillStyle = color; g.textAlign = align || 'left'; g.fillText(t, x, y); };
    const fit = (t, max) => { let s = String(t); while (s.length > 1 && g.measureText(s).width > max) s = s.slice(0, -2) + '…'; return s; };
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';

    // Шапка, как на командных картинках: логотип, «results», заголовок с оранжевой точкой.
    if (img) g.drawImage(img, P, 52, 290, 290 * img.height / img.width);
    font(400, 46);
    text('training', W - P, 100, '#9a9a9f', 'right');
    // Длинное название тренировки переносится на вторую строку.
    font(400, 36);
    const title = r.title.toLowerCase();
    if (g.measureText(title).width <= W - 2 * P) text(title, P, 200, C.white);
    else {
      font(400, 30);
      const words = title.split(' ');
      let first = '';
      while (words.length && g.measureText((first + ' ' + words[0]).trim()).width <= W - 2 * P) first = (first + ' ' + words.shift()).trim();
      text(first, P, 180, C.white);
      text(fit(words.join(' '), W - 2 * P), P, 220, C.white);
    }
    font(700, 112);
    const head = 'заезд ' + r.heatNo;
    text(head, P, 330, C.white);
    const hw = g.measureText(head).width;
    g.fillStyle = C.orange;
    g.beginPath();
    g.arc(P + hw + 22, 318, 13, 0, Math.PI * 2);
    g.fill();
    font(400, 28);
    text(fit([r.titled ? r.track : '', r.time, r.heatName].filter(Boolean).join(' · ').toLowerCase(), W - 2 * P), P, 384, C.hint);

    // Пилот: имя, позиция, карт, лучший круг.
    let y = 430;
    g.fillStyle = C.card;
    roundRect(g, P, y, W - 2 * P, 180, 22);
    font(700, 52);
    text(fit(r.name.toLowerCase(), 600), P + 30, y + 72, C.white);
    font(400, 26);
    text('p' + r.pos + ' из ' + r.total + ' · карт ' + r.kart + (r.laps ? ' · кругов ' + r.laps : ''), P + 30, y + 118, C.hint);
    if (isFinite(r.avg)) text('средний ' + timeFmt(r.avg), P + 30, y + 154, C.hint);
    font(400, 24);
    text('лучший круг', W - P - 30, y + 60, C.hint, 'right');
    font(700, 64);
    text(timeFmt(r.best), W - P - 30, y + 132, C.orange, 'right');

    // Отрывы: от беста заезда и от беста карта.
    y += 210;
    const tile = (x, w, label, gap, sub) => {
      g.fillStyle = C.card;
      roundRect(g, x, y, w, 190, 22);
      font(400, 24);
      text(label, x + 26, y + 46, C.hint);
      font(700, 56);
      text(gapFmt(gap), x + 26, y + 120, gap > 0.0005 ? C.orange : C.white);
      font(400, 22);
      text(fit(sub, w - 52), x + 26, y + 162, C.hint);
    };
    const half = (W - 2 * P - 20) / 2;
    tile(P, half, 'от беста заезда', r.heatBest ? r.best - r.heatBest.best : null,
      r.heatBest ? (r.heatBest.name === r.driverName ? 'это ваш круг · ' : r.heatBest.name.toLowerCase() + ' · ') + timeFmt(r.heatBest.best) : '');
    tile(P + half + 20, half, 'от беста карта', r.kartBest ? r.best - r.kartBest.best : null,
      r.kartBest ? (r.kartBest.driver === r.driverName ? 'это ваш круг · ' : String(r.kartBest.driver).toLowerCase() + ' · ') + timeFmt(r.kartBest.best) : 'нет данных карта');
    y += 230;

    // Таблица: строки с позицией, именем, лучшим кругом и отрывом от пилота.
    const table = (title, cols, rows) => {
      font(400, 26);
      text(title, P, y + 34, C.hint);
      cols.forEach((c) => text(c.label, c.x, y + 34, C.hint, c.align));
      y += 56;
      rows.forEach((row) => {
        g.fillStyle = C.line;
        g.fillRect(0, y, W, 2);
        if (row.me) {
          g.fillStyle = C.card;
          g.fillRect(0, y + 2, W, rowH - 2);
          g.fillStyle = C.orange;
          g.fillRect(0, y + 2, 8, rowH - 2);
        }
        row.cells.forEach((cell, i) => {
          const c = cols[i];
          font(cell.bold ? 700 : 400, 30);
          text(fit(cell.t, c.w || 400), c.x, y + 44, cell.color || C.white, c.align);
        });
        y += rowH;
      });
    };
    if (r.team.length) {
      table('команда в заезде', [
        { label: '', x: P, w: 80 }, { label: '', x: P + 90, w: 430 }, { label: 'карт', x: 640, align: 'right' },
        { label: 'лучший', x: 840, align: 'right' }, { label: 'к вам', x: W - P, align: 'right' },
      ], r.team.map((t) => ({
        me: t.me,
        cells: [
          { t: 'p' + t.pos, bold: true }, { t: t.name.toLowerCase() + (t.me ? ' · вы' : '') }, { t: String(t.kart) },
          { t: timeFmt(t.best) }, { t: t.me ? '' : gapFmt(r.best - t.best), color: r.best - t.best > 0.0005 ? C.orange : C.white },
        ],
      })));
      y += 40;
    }
    const kartRows = r.kartRows.length ? r.kartRows.map((k) => ({
      cells: [
        { t: k.date ? k.date.split('-').reverse().slice(0, 2).join('.') : '' }, { t: String(k.driver || '').toLowerCase() },
        { t: timeFmt(k.best) }, { t: gapFmt(r.best - k.best), color: r.best - k.best > 0.0005 ? C.orange : C.white },
      ],
    })) : [{ cells: [{ t: '' }, { t: r.kartError ? 'не удалось загрузить' : 'других заездов на этом карте нет', color: C.hint }, { t: '' }, { t: '' }] }];
    table('карт ' + r.kart + ' у других · ' + r.kartPeriod, [
      { label: '', x: P + 0, w: 110 }, { label: '', x: P + 130, w: 420 }, { label: 'лучший', x: 840, align: 'right' }, { label: 'к вам', x: W - P, align: 'right' },
    ], kartRows);

    font(400, 22);
    text('timing.batyrshin.name', P, H - 44, '#5c5c61');
    text('«+» — вы медленнее, «−» — быстрее', W - P, H - 44, '#5c5c61', 'right');
    return cv;
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
    g.fill();
  }

  let drawSeq = 0;
  async function drawPreviews() {
    const box = $('#r-previews');
    if (!box) return;
    const list = picks();
    if (!list.length) return;
    const seq = ++drawSeq;
    box.innerHTML = '<div class="hint">Готовлю PDF…</div>';
    const out = [];
    for (const p of list) {
      const kart = await kartInfo(p.heat, p.driver);
      const cv = await drawReport(buildReport(p, kart));
      if (seq !== drawSeq) return;
      out.push({ p, cv });
    }
    // Превью как будущий PDF: один документ на пилота, страницы — его заезды.
    box.innerHTML = '';
    const docs = new Map();
    out.forEach((x) => {
      if (!docs.has(x.p.person.key)) docs.set(x.p.person.key, { name: x.p.person.name, pages: [] });
      docs.get(x.p.person.key).pages.push(x.cv);
    });
    docs.forEach((d) => {
      const fig = document.createElement('figure');
      fig.innerHTML = '<figcaption><b>' + esc(d.name) + '</b> · PDF, ' + d.pages.length + ' стр.</figcaption>';
      const doc = document.createElement('div');
      doc.className = 'doc';
      d.pages.forEach((cv) => { cv.className = 'preview'; doc.appendChild(cv); });
      fig.appendChild(doc);
      box.appendChild(fig);
    });
    res.rendered = out;
  }

  // Простой PDF без библиотек: каждая картинка — отдельная страница (JPEG).
  function pdfFromCanvases(canvases) {
    const enc = (str) => { const b = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 255; return b; };
    const parts = [];
    const offsets = [];
    let size = 0;
    const push = (x) => { const b = typeof x === 'string' ? enc(x) : x; parts.push(b); size += b.length; };
    const obj = (n, body) => { offsets[n] = size; push(n + ' 0 obj\n'); body.forEach(push); push('\nendobj\n'); };
    const n = canvases.length;
    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    obj(2, ['<< /Type /Pages /Count ' + n + ' /Kids [' + canvases.map((c, i) => (3 + i * 3) + ' 0 R').join(' ') + '] >>']);
    canvases.forEach((cv, i) => {
      const page = 3 + i * 3;
      const w = (cv.width * 0.75).toFixed(2);
      const h = (cv.height * 0.75).toFixed(2);
      const jpeg = enc(atob(cv.toDataURL('image/jpeg', 0.92).split(',')[1]));
      const draw = 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q';
      obj(page, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + '] /Resources << /XObject << /Im0 ' + (page + 1) + ' 0 R >> >> /Contents ' + (page + 2) + ' 0 R >>']);
      obj(page + 1, ['<< /Type /XObject /Subtype /Image /Width ' + cv.width + ' /Height ' + cv.height + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n', jpeg, '\nendstream']);
      obj(page + 2, ['<< /Length ' + draw.length + ' >>\nstream\n' + draw + '\nendstream']);
    });
    const total = 3 + n * 3;
    const xref = size;
    let table = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let i = 1; i < total; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    push(table + 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    const all = new Uint8Array(size);
    let pos = 0;
    parts.forEach((b) => { all.set(b, pos); pos += b.length; });
    let bin = '';
    for (let i = 0; i < all.length; i += 0x8000) bin += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function sendResults() {
    const list = res.rendered || [];
    if (!list.length) return;
    const byPerson = new Map();
    list.forEach((x) => {
      if (!byPerson.has(x.p.person.key)) byPerson.set(x.p.person.key, { key: x.p.person.key, name: x.p.person.name, pages: [], date: x.p.heat.date });
      byPerson.get(x.p.person.key).pages.push(x.cv);
    });
    // Каждому пилоту — один PDF: страница на каждый заезд.
    const items = Array.from(byPerson.values()).map((x) => ({
      key: x.key,
      pdf: pdfFromCanvases(x.pages),
      fileName: 'M-ELVN_training_' + (x.date || today()) + '.pdf',
      caption: '🏁 Результаты тренировки' + (res.title ? ': ' + res.title : '') + (x.pages.length > 1 ? ' (заездов: ' + x.pages.length + ')' : ''),
    }));
    if (!(await confirmBox('Отправить PDF: ' + Array.from(byPerson.values()).map((x) => x.name + ' (заездов: ' + x.pages.length + ')').join(', ') + '?', 'Отправить'))) return;
    res.sending = true;
    render();
    try {
      const out = await call('admin_sendResults', items);
      const bad = out.filter((x) => x.error);
      const why = { no_chat: 'бот не знает его Telegram: пусть один раз откроет приложение', blocked: 'не нажал «Старт» в боте или заблокировал его', not_found: 'нет в «Людях»' };
      if (bad.length) toast('Не отправлено: ' + bad.map((x) => (x.name || x.key) + ' — ' + (why[x.error] || x.error)).join('; '), true);
      else toast('Отправлено: ' + out.length);
    } catch (e) {
      toast('Не удалось отправить: ' + (e && e.message ? e.message : e), true);
    }
    res.sending = false;
    render();
  }
