// Интерфейс Mini App: список событий и карточка события.
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const app = document.getElementById('app');
  const who = document.getElementById('who');
  let view = null;
  let tab = 'upcoming';

  if (tg) {
    tg.ready();
    tg.expand();
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

  function renderList() {
    if (tg) tg.BackButton.hide();
    const t = today();
    const upcoming = view.events.filter((e) => e.date >= t);
    const past = view.events.filter((e) => e.date < t).reverse();
    const list = tab === 'upcoming' ? upcoming : past;

    const items = list
      .map((e) => {
        const badge = e.cancelled
          ? '<span class="badge off">Отменено</span>'
          : `<span class="badge ${/гонк/i.test(e.type) ? 'race' : ''}">${esc(e.type)}</span>`;
        const meta = [fmtDate(e.date), fmtTime(e), e.track].filter(Boolean).map(esc).join(' · ');
        return `<button class="card ${e.cancelled ? 'cancelled' : ''}" data-id="${esc(e.id)}">
          <div class="row"><div class="title">${esc(e.title)}</div>${badge}</div>
          <div class="meta">${meta}</div>
        </button>`;
      })
      .join('');

    app.innerHTML = `
      <div class="tabs">
        <button class="tab ${tab === 'upcoming' ? 'on' : ''}" data-tab="upcoming">Предстоящие (${upcoming.length})</button>
        <button class="tab ${tab === 'past' ? 'on' : ''}" data-tab="past">Прошедшие (${past.length})</button>
      </div>
      ${items || `<div class="state">${tab === 'upcoming' ? 'Пока нет запланированных событий.' : 'Прошедших событий нет.'}</div>`}
    `;
    app.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab;
        renderList();
      }),
    );
    app.querySelectorAll('[data-id]').forEach((b) =>
      b.addEventListener('click', () => renderEvent(b.dataset.id)),
    );
  }

  function personLine(p) {
    const phone = p.phone ? ` <span class="small">${esc(p.phone)}</span>` : '';
    return `<div class="person ${p.me ? 'me' : ''}"><a href="https://t.me/${esc(p.handle)}" data-ext>${esc(p.name)}</a>${phone}</div>`;
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

    const crews = e.crews
      .map(
        (c) => `<div class="crew ${c.mine ? 'mine' : ''}">
          <div class="crew-name">${esc(c.name || 'Экипаж')}${c.kart ? ` <span class="small">карт №${esc(c.kart)}</span>` : ''}</div>
          ${c.pilots.map(personLine).join('')}
          ${c.managers.length ? `<div class="small" style="margin-top:4px">Менеджер:</div>${c.managers.map(personLine).join('')}` : ''}
        </div>`,
      )
      .join('');

    app.innerHTML = `
      ${tg ? '' : '<button class="back">‹ Назад</button>'}
      <div class="section">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div class="title" style="font-weight:700;font-size:19px">${esc(e.title)}</div>
          ${e.cancelled ? '<span class="badge off">Отменено</span>' : `<span class="badge ${/гонк/i.test(e.type) ? 'race' : ''}">${esc(e.type)}</span>`}
        </div>
        <div class="meta small" style="margin-top:4px">${esc(fmtDate(e.date))}${e.start ? ' · ' + esc(fmtTime(e)) : ''}</div>
      </div>
      <div class="section">
        <h3>Детали</h3>
        ${kv('Трасса', esc(e.track))}
        ${kv('Адрес', e.address ? `<a href="https://yandex.ru/maps/?text=${encodeURIComponent(e.address)}" data-ext>${esc(e.address)}</a>` : '')}
        ${kv('Стоимость', esc(e.cost))}
        ${kv('Регламент', rules)}
      </div>
      ${e.description ? `<div class="section"><h3>Описание</h3><div class="desc">${esc(e.description)}</div></div>` : ''}
      ${crews ? `<div class="section"><h3>Составы</h3>${crews}</div>` : ''}
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
      const res = await fetch('/api/me', { headers: { 'x-telegram-init-data': initData } });
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
      renderList();
    } catch (e) {
      state('Нет связи', 'Проверьте интернет и откройте приложение снова.');
    }
  }

  load();
})();
