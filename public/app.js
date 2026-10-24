// Интерфейс Mini App: список событий и карточка события.
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const app = document.getElementById('app');
  const who = document.getElementById('who');
  let view = null;
  let tab = 'upcoming';
  let mainView = 'list'; // «Список гонок» или «Календарь»
  let calCursor = null; // показываемый месяц {y, m}; null — текущий
  let calSelected = null; // выбранный день 'YYYY-MM-DD'
  // Выбранные чемпионаты; пустой список — показывать все.
  let champFilter = [];
  const NO_CHAMP = '__none__';
  const FILTER_KEY = 'champ_filter';

  if (tg) {
    tg.ready();
    tg.expand();
    // Командные цвета в шапке и фоне Telegram.
    try {
      tg.setHeaderColor('#101011');
      tg.setBackgroundColor('#101011');
    } catch (e) {}
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  function fmtDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const wd = DAYS[new Date(y, m - 1, d).getDay()];
    return `${d} ${MONTHS[m - 1]}, ${wd}`;
  }
  const fmtTime = (e) => (e.start ? e.start + (e.end ? '–' + e.end : '') : '');
  const today = () => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  };

  function state(title, text) {
    app.innerHTML = `<div class="state"><b>${esc(title)}</b>${text}</div>`;
  }

  function roleNames(r) {
    return [r.pilot && 'пилот', r.manager && 'менеджер', r.leadership && 'руководство'].filter(Boolean).join(', ');
  }

  function openLink(url) {
    if (tg && tg.openLink) tg.openLink(url);
    else window.open(url, '_blank');
  }

  // Фильтр хранится в облаке Telegram (виден на всех устройствах человека),
  // а если оно недоступно — в браузере.
  function loadFilter() {
    return new Promise((resolve) => {
      const parse = (v) => {
        try {
          const a = JSON.parse(v || '[]');
          return Array.isArray(a) ? a : [];
        } catch (e) {
          return [];
        }
      };
      const fromLocal = () => {
        try {
          resolve(parse(localStorage.getItem(FILTER_KEY)));
        } catch (e) {
          resolve([]);
        }
      };
      if (tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9')) {
        try {
          tg.CloudStorage.getItem(FILTER_KEY, (err, v) => (err ? fromLocal() : resolve(parse(v))));
          return;
        } catch (e) {}
      }
      fromLocal();
    });
  }

  function saveFilter() {
    const v = JSON.stringify(champFilter);
    try {
      localStorage.setItem(FILTER_KEY, v);
    } catch (e) {}
    try {
      if (tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9')) tg.CloudStorage.setItem(FILTER_KEY, v);
    } catch (e) {}
  }

  const champKey = (e) => e.championship || NO_CHAMP;

  // «Кубок Москвы · Этап 3»; пусто, если название события и так из них собрано.
  function champLabel(e) {
    if (e.title === [e.championship, e.stage].filter(Boolean).join(' — ')) return '';
    return [e.championship, e.stage].filter(Boolean).join(' · ');
  }

  const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const isoOf = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  function cardHtml(e) {
    const meta = [fmtDate(e.date), fmtTime(e), e.track].filter(Boolean).map(esc).join(' · ');
    const champ = champLabel(e);
    const champLine = champ ? `<div class="champ">${esc(champ)}</div>` : '';
    return `<button class="card ${e.cancelled ? 'cancelled' : ''}" data-id="${esc(e.id)}">
      ${champLine}
      <div class="title">${esc(e.title)}</div>
      <div class="meta">${meta}</div>
      ${badges(e)}
    </button>`;
  }

  function listBody(shown) {
    const t = today();
    const upcoming = shown.filter((e) => e.date >= t);
    const past = shown.filter((e) => e.date < t).reverse();
    const list = tab === 'upcoming' ? upcoming : past;
    return `
      <div class="tabs">
        <button class="tab ${tab === 'upcoming' ? 'on' : ''}" data-tab="upcoming">Предстоящие (${upcoming.length})</button>
        <button class="tab ${tab === 'past' ? 'on' : ''}" data-tab="past">Прошедшие (${past.length})</button>
      </div>
      ${list.map(cardHtml).join('') || `<div class="state">${tab === 'upcoming' ? 'Пока нет запланированных событий.' : 'Прошедших событий нет.'}</div>`}
    `;
  }

  // Месяц сеткой: недели с понедельника, дни с гонками оранжевые, сегодня обведён.
  function calendarBody(shown) {
    const t = today();
    if (!calCursor) {
      const [ty, tm] = t.split('-').map(Number);
      calCursor = { y: ty, m: tm - 1 };
    }
    const { y, m } = calCursor;
    const byDate = {};
    for (const e of shown) (byDate[e.date] = byDate[e.date] || []).push(e);

    const offset = (new Date(y, m, 1).getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    let cells = '<span class="cal-cell empty"></span>'.repeat(offset);
    for (let d = 1; d <= days; d++) {
      const iso = isoOf(y, m, d);
      const evs = byDate[iso] || [];
      const live = evs.some((e) => !e.cancelled);
      const cls = [
        'cal-cell',
        live ? 'has' : evs.length ? 'has-off' : '',
        iso === t ? 'today' : '',
        iso === calSelected ? 'sel' : '',
      ].join(' ');
      const dots = evs.length > 1 ? `<span class="cal-count">${evs.length}</span>` : '';
      cells += `<button class="${cls}" data-day="${iso}">${d}${dots}</button>`;
    }

    const monthPrefix = isoOf(y, m, 1).slice(0, 7);
    let below;
    if (calSelected && calSelected.startsWith(monthPrefix)) {
      const evs = byDate[calSelected] || [];
      below = `<div class="cal-caption">${esc(fmtDate(calSelected))}</div>
        ${evs.map(cardHtml).join('') || '<div class="state">В этот день гонок нет.</div>'}`;
    } else {
      const evs = shown.filter((e) => e.date.startsWith(monthPrefix));
      below = `<div class="cal-caption">${evs.length ? 'Гонки в этом месяце' : 'В этом месяце гонок нет'}</div>
        ${evs.map(cardHtml).join('')}`;
    }

    const isCurrent = t.startsWith(monthPrefix);
    return `
      <div class="section cal-box">
        <div class="cal-head">
          <button class="cal-nav" data-shift="-12" aria-label="Предыдущий год">«</button>
          <button class="cal-nav" data-shift="-1" aria-label="Предыдущий месяц">‹</button>
          <div class="cal-title">${MONTHS_NOM[m]} ${y}</div>
          <button class="cal-nav" data-shift="1" aria-label="Следующий месяц">›</button>
          <button class="cal-nav" data-shift="12" aria-label="Следующий год">»</button>
        </div>
        <div class="cal-grid">
          ${WEEKDAYS.map((w, i) => `<span class="cal-wd ${i > 4 ? 'we' : ''}">${w}</span>`).join('')}
          ${cells}
        </div>
        ${isCurrent ? '' : '<button class="cal-today" data-today>Сегодня</button>'}
      </div>
      ${below}
    `;
  }

  function renderList() {
    if (tg) tg.BackButton.hide();

    // Чемпионаты из событий человека; выбор, которого больше нет, игнорируется.
    const champs = [...new Set(view.events.map(champKey))].sort((a, b) =>
      a === NO_CHAMP ? 1 : b === NO_CHAMP ? -1 : a.localeCompare(b, 'ru'),
    );
    const active = champFilter.filter((c) => champs.includes(c));
    const shown = active.length ? view.events.filter((e) => active.includes(champKey(e))) : view.events;

    const chips =
      champs.length > 1 || (champs.length === 1 && champs[0] !== NO_CHAMP)
        ? `<div class="chips">
            <button class="chip ${active.length ? '' : 'on'}" data-champ="">Все</button>
            ${champs
              .map(
                (c) =>
                  `<button class="chip ${active.includes(c) ? 'on' : ''}" data-champ="${esc(c)}">${esc(c === NO_CHAMP ? 'Без чемпионата' : c)}</button>`,
              )
              .join('')}
          </div>`
        : '';

    app.innerHTML = `
      <div class="nav">
        <button class="nav-btn ${mainView === 'list' ? 'on' : ''}" data-view="list">Список гонок</button>
        <button class="nav-btn ${mainView === 'calendar' ? 'on' : ''}" data-view="calendar">Календарь</button>
      </div>
      ${chips}
      ${mainView === 'calendar' ? calendarBody(shown) : listBody(shown)}
    `;
    app.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        mainView = b.dataset.view;
        renderList();
      }),
    );
    app.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab;
        renderList();
      }),
    );
    app.querySelectorAll('[data-champ]').forEach((b) =>
      b.addEventListener('click', () => {
        const c = b.dataset.champ;
        if (!c) champFilter = [];
        else champFilter = active.includes(c) ? active.filter((x) => x !== c) : [...active, c];
        saveFilter();
        renderList();
      }),
    );
    app.querySelectorAll('[data-shift]').forEach((b) =>
      b.addEventListener('click', () => {
        const d = new Date(calCursor.y, calCursor.m + Number(b.dataset.shift), 1);
        calCursor = { y: d.getFullYear(), m: d.getMonth() };
        renderList();
      }),
    );
    const todayBtn = app.querySelector('[data-today]');
    if (todayBtn)
      todayBtn.addEventListener('click', () => {
        calCursor = null;
        calSelected = today();
        renderList();
      });
    app.querySelectorAll('[data-day]').forEach((b) =>
      b.addEventListener('click', () => {
        calSelected = calSelected === b.dataset.day ? null : b.dataset.day;
        renderList();
      }),
    );
    app.querySelectorAll('[data-id]').forEach((b) =>
      b.addEventListener('click', () => renderEvent(b.dataset.id)),
    );
  }

  const FORMAT = { team: 'Командная', solo: 'Личная' };
  const ROLE = { pilot: 'Пилот', manager: 'Менеджер' };

  function badges(e) {
    if (e.cancelled) return '<span class="badges"><span class="badge off">Отменено</span></span>';
    const type = `<span class="badge ${/гонк/i.test(e.type) ? 'race' : ''}">${esc(e.type)}</span>`;
    const format = FORMAT[e.format] ? `<span class="badge">${FORMAT[e.format]}</span>` : '';
    const roles = (e.myRoles || []).map((r) => `<span class="badge role">${ROLE[r]}</span>`).join('');
    return `<span class="badges">${type}${format}${roles}</span>`;
  }

  function personLine(p) {
    const phone = p.phone ? ` <span class="small">${esc(p.phone)}</span>` : '';
    const name = p.handle ? `<a href="https://t.me/${esc(p.handle)}" data-ext>${esc(p.name)}</a>` : esc(p.name);
    return `<div class="person ${p.me ? 'me' : ''}">${name}${p.me ? ' <span class="you">вы</span>' : ''}${phone}</div>`;
  }

  function renderEvent(id) {
    const e = view.events.find((x) => x.id === id);
    if (!e) return renderList();
    if (tg) {
      tg.BackButton.show();
      tg.BackButton.offClick(renderList);
      tg.BackButton.onClick(renderList);
    }

    const kv = (k, v) => (v ? `<div class="kv"><span>${esc(k)}</span><span>${v}</span></div>` : '');
    const rules = e.rules
      ? /^https?:\/\//.test(e.rules)
        ? `<a href="${esc(e.rules)}" data-ext>Открыть</a>`
        : esc(e.rules)
      : '';

    const defaultTitle = e.format === 'team' ? 'Состав команды' : 'Участники';
    const crews = (e.crews || [])
      .map(
        (c) => `<div class="section crew ${c.mine ? 'mine' : ''}">
          <h3>${esc(c.name || defaultTitle)}${c.mine ? ' <span class="you">ваш состав</span>' : ''}</h3>
          ${c.pilots.map(personLine).join('')}
          ${c.managers.length ? `<div class="role-label">Менеджер</div>${c.managers.map(personLine).join('')}` : ''}
        </div>`,
      )
      .join('');

    app.innerHTML = `
      ${tg ? '' : '<button class="back">‹ Назад</button>'}
      <div class="section">
        <div class="title" style="font-weight:700;font-size:19px">${esc(e.title)}</div>
        ${champLabel(e) ? `<div class="champ" style="margin-top:4px">${esc(champLabel(e))}</div>` : ''}
        <div class="meta small" style="margin-top:4px">${esc(fmtDate(e.date))}${e.start ? ' · ' + esc(fmtTime(e)) : ''}</div>
        ${badges(e)}
      </div>
      <div class="section">
        <h3>Детали</h3>
        ${kv('Трасса', esc(e.track))}
        ${kv('Адрес', e.address ? `<a href="https://yandex.ru/maps/?text=${encodeURIComponent(e.address)}" data-ext>${esc(e.address)}</a>` : '')}
        ${kv('Стоимость', esc(e.cost))}
        ${kv('Регламент', rules)}
      </div>
      ${e.description ? `<div class="section"><h3>Описание</h3><div class="desc">${esc(e.description)}</div></div>` : ''}
      ${crews}
      ${e.cancelled ? '' : '<button class="cal">Добавить в Google Календарь</button>'}
    `;
    const back = app.querySelector('.back');
    if (back) back.addEventListener('click', renderList);
    const cal = app.querySelector('.cal');
    if (cal) cal.addEventListener('click', () => openLink(e.calendarUrl));
    app.querySelectorAll('a[data-ext]').forEach((a) =>
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const href = a.getAttribute('href');
        if (tg && href.startsWith('https://t.me/') && tg.openTelegramLink) tg.openTelegramLink(href);
        else openLink(href);
      }),
    );
    window.scrollTo(0, 0);
  }

  async function load() {
    const initData = tg ? tg.initData : '';
    if (!initData) {
      return state('Откройте через Telegram', 'Это приложение работает только внутри бота команды M-ELVN.');
    }
    try {
      // Простой GET без своих заголовков: так Apps Script отвечает без проблем с CORS.
      const res = await fetch(window.MELVN_API_URL + '?initData=' + encodeURIComponent(initData));
      const body = await res.json();
      if (body.error === 'not_telegram') {
        return state('Не удалось проверить вход', 'Закройте приложение и откройте его снова из бота.');
      }
      if (body.error) {
        return state('Данные временно недоступны', 'Попробуйте через минуту. Если не поможет, напишите администратору.');
      }
      view = body;
      if (!view.access) {
        const id = view.username ? `ваш ник <b>@${esc(view.username)}</b>` : `ваш Telegram ID <b>${esc(view.telegramId)}</b>`;
        return state('Нет доступа', `Попросите администратора добавить ${id} на лист «Люди» в таблице команды.`);
      }
      who.innerHTML = `${esc(view.me.name)}<br>${esc(roleNames(view.me.roles))}`;
      champFilter = await loadFilter();
      renderList();
    } catch (e) {
      state('Нет связи', 'Проверьте интернет и откройте приложение снова.');
    }
  }

  load();
})();
