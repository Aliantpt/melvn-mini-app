// Чистая логика: разбор данных таблицы, роли, видимость, ссылки на календарь.
// Работает и в Node (тесты), и в Google Apps Script (scripts/build-gas.mjs убирает `export`).

const YES = new Set(['да', 'yes', 'true', '1', '+', 'x', 'х']);

export function isYes(v) {
  return YES.has(String(v ?? '').trim().toLowerCase());
}

// Ник или числовой Telegram ID, без @ и в нижнем регистре.
export function normHandle(v) {
  return String(v ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').toLowerCase();
}

export function splitHandles(v) {
  return String(v ?? '')
    .split(/[,;\n]+/)
    .map(normHandle)
    .filter(Boolean);
}

// «15.11.2026» или «2026-11-15» → {y, m, d}
export function parseDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  return null;
}

// «10:00» или «10:00:00» → {h, min}
export function parseTime(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2})[:.](\d{2})/);
  return m ? { h: +m[1], min: +m[2] } : null;
}

const pad = (n) => String(n).padStart(2, '0');

export function buildPeople(rows) {
  const people = [];
  for (const r of rows || []) {
    const handle = normHandle(r['Telegram']);
    if (!handle) continue;
    people.push({
      handle,
      name: String(r['Имя'] || '').trim() || '@' + handle,
      phone: String(r['Телефон'] || '').trim(),
      active: String(r['Активен'] || '').trim().toLowerCase() !== 'нет',
      roles: {
        pilot: isYes(r['Пилот']),
        manager: isYes(r['Менеджер']),
        leadership: isYes(r['Руководство']),
      },
    });
  }
  return people;
}

export function buildEvents(eventRows, crewRows) {
  const crewsByEvent = new Map();
  for (const r of crewRows || []) {
    const eventId = String(r['ID события'] || '').trim();
    if (!eventId) continue;
    const crew = {
      name: String(r['Экипаж'] || '').trim(),
      kart: String(r['Номер карта'] || '').trim(),
      managers: splitHandles(r['Менеджер']),
      pilots: splitHandles(r['Пилоты']),
    };
    if (!crewsByEvent.has(eventId)) crewsByEvent.set(eventId, []);
    crewsByEvent.get(eventId).push(crew);
  }

  const events = [];
  for (const r of eventRows || []) {
    const id = String(r['ID'] || '').trim();
    const date = parseDate(r['Дата']);
    if (!id || !date) continue;
    events.push({
      id,
      type: String(r['Тип'] || '').trim() || 'Событие',
      title: String(r['Название'] || '').trim() || id,
      date,
      start: parseTime(r['Начало']),
      end: parseTime(r['Окончание']),
      track: String(r['Трасса'] || '').trim(),
      address: String(r['Адрес'] || '').trim(),
      cost: String(r['Стоимость'] || '').trim(),
      rules: String(r['Регламент'] || '').trim(),
      description: String(r['Описание'] || '').trim(),
      cancelled: String(r['Статус'] || '').trim().toLowerCase().startsWith('отмен'),
      crews: crewsByEvent.get(id) || [],
    });
  }
  return events;
}

export function findPerson(people, tgUser) {
  const keys = new Set();
  if (tgUser?.username) keys.add(normHandle(tgUser.username));
  if (tgUser?.id) keys.add(String(tgUser.id));
  return people.find((p) => keys.has(p.handle)) || null;
}

// Что видит человек: руководство — всё; пилот — события, где он в составе;
// менеджер — события, где он менеджер экипажа. Роли складываются.
export function visibleEvents(events, person) {
  if (!person || !person.active) return [];
  if (person.roles.leadership) return events;
  return events.filter((e) =>
    e.crews.some(
      (c) =>
        (person.roles.pilot && c.pilots.includes(person.handle)) ||
        (person.roles.manager && c.managers.includes(person.handle)),
    ),
  );
}

function stamp(date, time) {
  const d = `${date.y}${pad(date.m)}${pad(date.d)}`;
  return time ? `${d}T${pad(time.h)}${pad(time.min)}00` : d;
}

function nextDay(date) {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function calendarDetails(event, nameOf) {
  const lines = [event.type];
  if (event.track) lines.push(`Трасса: ${event.track}`);
  if (event.cost) lines.push(`Стоимость: ${event.cost}`);
  if (event.rules) lines.push(`Регламент: ${event.rules}`);
  if (event.description) lines.push('', event.description);
  if (event.crews.length) {
    lines.push('', 'Составы:');
    for (const c of event.crews) {
      const title = [c.name, c.kart && `карт №${c.kart}`].filter(Boolean).join(', ');
      lines.push(`• ${title}: ${c.pilots.map(nameOf).join(', ')}`);
      if (c.managers.length) lines.push(`  Менеджер: ${c.managers.map(nameOf).join(', ')}`);
    }
  }
  return lines.join('\n');
}

export function googleCalendarUrl(event, timezone, nameOf = (h) => '@' + h) {
  let dates;
  if (event.start) {
    const end = event.end || { h: Math.min(event.start.h + 2, 23), min: event.start.min };
    dates = `${stamp(event.date, event.start)}/${stamp(event.date, end)}`;
  } else {
    dates = `${stamp(event.date)}/${stamp(nextDay(event.date))}`;
  }
  // Без URLSearchParams: в Google Apps Script его нет.
  const params = {
    action: 'TEMPLATE',
    text: `${event.title} (M-ELVN)`,
    dates,
    details: calendarDetails(event, nameOf),
    location: [event.track, event.address].filter(Boolean).join(', '),
  };
  if (event.start && timezone) params.ctz = timezone;
  const query = Object.keys(params)
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
  return 'https://calendar.google.com/calendar/render?' + query;
}

// Сборка ответа для экрана приложения.
export function buildView(data, tgUser, timezone) {
  const people = buildPeople(data['Люди']);
  const person = findPerson(people, tgUser);
  if (!person || !person.active) {
    return {
      access: false,
      username: tgUser?.username || null,
      telegramId: tgUser?.id ?? null,
    };
  }

  const byHandle = new Map(people.map((p) => [p.handle, p]));
  const nameOf = (h) => byHandle.get(h)?.name || '@' + h;
  const personCard = (h) => {
    const p = byHandle.get(h);
    return { handle: h, name: nameOf(h), phone: p?.phone || '', me: h === person.handle };
  };

  const events = visibleEvents(buildEvents(data['События'], data['Составы']), person)
    .map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      date: `${e.date.y}-${pad(e.date.m)}-${pad(e.date.d)}`,
      start: e.start ? `${pad(e.start.h)}:${pad(e.start.min)}` : '',
      end: e.end ? `${pad(e.end.h)}:${pad(e.end.min)}` : '',
      track: e.track,
      address: e.address,
      cost: e.cost,
      rules: e.rules,
      description: e.description,
      cancelled: e.cancelled,
      calendarUrl: googleCalendarUrl(e, timezone, nameOf),
      crews: e.crews.map((c) => ({
        name: c.name,
        kart: c.kart,
        managers: c.managers.map(personCard),
        pilots: c.pilots.map(personCard),
        mine: c.pilots.includes(person.handle) || c.managers.includes(person.handle),
      })),
    }))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  return {
    access: true,
    me: { name: person.name, handle: person.handle, roles: person.roles },
    events,
    updatedAt: data.updatedAt || null,
  };
}
