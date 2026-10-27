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

// Простое сравнение строк: у localeCompare в Apps Script порядок может отличаться.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// По дате и времени начала, от ранних к поздним.
export const byWhen = (a, b) => cmp(a.date + ' ' + (a.start || ''), b.date + ' ' + (b.start || ''));

// Человека можно указать ником или числовым Telegram ID — подходят оба.
export function buildPeople(rows) {
  const people = [];
  for (const r of rows || []) {
    const keys = [normHandle(r['Telegram']), normHandle(r['Telegram ID'])].filter(Boolean);
    if (!keys.length) continue;
    people.push({
      key: keys[0],
      keys,
      handle: /^\d+$/.test(keys[0]) ? '' : keys[0],
      name: String(r['Имя'] || '').trim() || '@' + keys[0],
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

// «Командная» / «Личная»; пусто — не указан.
export function parseFormat(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.startsWith('команд')) return 'team';
  if (s.startsWith('личн')) return 'solo';
  return '';
}

// Этап «3» → «Этап 3» у гонки и «Тренировка 3» у тренировки; текст — как есть.
export function stageLabel(stage, type) {
  if (!/^\d+$/.test(stage)) return stage;
  return (/трен/i.test(type) ? 'Тренировка ' : 'Этап ') + stage;
}

// Составы указываются прямо в таблице событий. Одна строка — один состав.
// Если в гонке несколько составов, добавляется ещё строка с тем же ID:
// в ней достаточно заполнить «Состав», «Менеджер» и «Пилоты», остальное
// берётся из первой строки события.
export function buildEvents(eventRows) {
  const byId = new Map();
  const events = [];
  for (const r of eventRows || []) {
    const id = String(r['ID'] || '').trim();
    if (!id) continue;
    let e = byId.get(id);
    if (!e) {
      const date = parseDate(r['Дата']);
      if (!date) continue;
      e = {
        id,
        type: String(r['Тип'] || '').trim() || 'Событие',
        format: parseFormat(r['Формат']),
        championship: String(r['Чемпионат'] || '').trim(),
        stage: String(r['Этап'] || '').trim(),
        title: String(r['Название'] || '').trim(),
        date,
        start: parseTime(r['Начало']),
        end: parseTime(r['Окончание']),
        track: String(r['Трасса'] || '').trim(),
        address: String(r['Адрес'] || '').trim(),
        cost: String(r['Стоимость'] || '').trim(),
        rules: String(r['Регламент'] || '').trim(),
        description: String(r['Описание'] || '').trim(),
        cancelled: String(r['Статус'] || '').trim().toLowerCase().startsWith('отмен'),
        crews: [],
      };
      e.stageLabel = stageLabel(e.stage, e.type);
      if (!e.title) e.title = [e.championship, e.stageLabel].filter(Boolean).join(' — ') || id;
      byId.set(id, e);
      events.push(e);
    }
    const crew = {
      name: String(r['Состав'] || '').trim(),
      managers: splitHandles(r['Менеджер']),
      pilots: splitHandles(r['Пилоты']),
    };
    if (crew.name || crew.managers.length || crew.pilots.length) e.crews.push(crew);
  }
  return events;
}

export function findPerson(people, tgUser) {
  const keys = new Set();
  if (tgUser?.username) keys.add(normHandle(tgUser.username));
  if (tgUser?.id) keys.add(String(tgUser.id));
  return people.find((p) => p.keys.some((k) => keys.has(k))) || null;
}

const listsPerson = (list, person) => list.some((k) => person.keys.includes(k));

const inCrew = (c, person) => listsPerson(c.pilots, person) || listsPerson(c.managers, person);

// Руководство видит всё; остальные — только события, где их вписали
// пилотом или менеджером хотя бы одного состава. Все составы гонки видны.
export function visibleEvents(events, person) {
  if (!person || !person.active) return [];
  if (person.roles.leadership) return events;
  return events.filter((e) => e.crews.some((c) => inCrew(c, person)));
}

function stamp(date, time) {
  const d = `${date.y}${pad(date.m)}${pad(date.d)}`;
  return time ? `${d}T${pad(time.h)}${pad(time.min)}00` : d;
}

function nextDay(date) {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export const FORMAT_LABEL = { team: 'Командная', solo: 'Личная' };

export function calendarDetails(event, nameOf) {
  const lines = [[event.type, FORMAT_LABEL[event.format]].filter(Boolean).join(', ')];
  const champ = [event.championship, event.stageLabel].filter(Boolean).join(' — ');
  if (champ && champ !== event.title) lines.push(`Чемпионат: ${champ}`);
  if (event.track) lines.push(`Трасса: ${event.track}`);
  if (event.cost) lines.push(`Стоимость: ${event.cost}`);
  if (event.rules) lines.push(`Регламент: ${event.rules}`);
  if (event.description) lines.push('', event.description);
  for (const c of event.crews) {
    lines.push('', `${c.name || (event.format === 'team' ? 'Состав команды' : 'Участники')}:`);
    if (c.pilots.length) lines.push(`Пилоты: ${c.pilots.map(nameOf).join(', ')}`);
    if (c.managers.length) lines.push(`Менеджер: ${c.managers.map(nameOf).join(', ')}`);
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

// «7 000 ₽ с пилота» → 7000; «10.000» → 10000; «1 500,50» → 1500.5; нет числа → 0.
export function parseMoney(v) {
  const s = String(v ?? '').replace(/[\s\u00a0\u202f]/g, '');
  const m = s.match(/\d+(?:[.,]\d+)*/);
  if (!m) return 0;
  let n = m[0];
  // Точка или запятая перед ровно тремя цифрами — разделитель тысяч.
  n = n.replace(/[.,](?=\d{3}(?:[.,]|$))/g, '').replace(',', '.');
  const x = Number(n);
  return isFinite(x) ? x : 0;
}

// Категория для диаграммы: все тренировки вместе, гонки — по чемпионату.
export function financeCategory(e) {
  if (/трен/i.test(e.type)) return 'Тренировки';
  return e.championship || 'Без чемпионата';
}

const isoDate = (d) => `${d.y}-${pad(d.m)}-${pad(d.d)}`;

// Траты пилота: «Стоимость» каждой его (не отменённой) гонки. В командной
// гонке она делится на число пилотов его состава.
export function buildSpent(events, person) {
  const items = [];
  for (const e of events) {
    if (e.cancelled) continue;
    const total = parseMoney(e.cost);
    if (!total) continue;
    for (const c of e.crews) {
      if (!listsPerson(c.pilots, person)) continue;
      const share = e.format === 'team' && c.pilots.length > 1 ? total / c.pilots.length : total;
      items.push({
        raceId: e.id,
        title: e.title,
        date: isoDate(e.date),
        category: financeCategory(e),
        amount: Math.round(share * 100) / 100,
        // Полная стоимость и число пилотов — чтобы показать «12 000 ₽ ÷ 2».
        fullCost: share !== total ? total : 0,
        split: share !== total ? c.pilots.length : 0,
        note: '',
      });
      break;
    }
  }
  return items;
}

// Доход менеджера: его записи с листа «Заработок».
export function buildEarned(events, person, incomeRows) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const items = [];
  for (const r of incomeRows || []) {
    const who = normHandle(r['Менеджер']);
    if (!who || !person.keys.includes(who)) continue;
    const amount = parseMoney(r['Сумма']);
    if (!amount) continue;
    const e = byId.get(String(r['ID гонки'] || '').trim());
    items.push({
      id: String(r['ID'] || '').trim(),
      raceId: e ? e.id : String(r['ID гонки'] || '').trim(),
      title: e ? e.title : String(r['ID гонки'] || '').trim() || 'Без гонки',
      date: e ? isoDate(e.date) : String(r['Дата записи'] || '').slice(0, 10),
      category: e ? financeCategory(e) : 'Без чемпионата',
      amount,
      note: String(r['Комментарий'] || '').trim(),
    });
  }
  return items;
}

// Гонки, за которые менеджер может внести доход.
export function managedRaces(events, person) {
  return events
    .filter((e) => e.crews.some((c) => listsPerson(c.managers, person)))
    .map((e) => ({ id: e.id, title: e.title, date: isoDate(e.date) }))
    .sort((a, b) => cmp(b.date, a.date));
}

export function canAddIncome(events, person, raceId) {
  const e = events.find((x) => x.id === raceId);
  return !!e && e.crews.some((c) => listsPerson(c.managers, person));
}

// ---- Открытые тренировки (лист «Тренировки») ----
// Админ не вписывает пилотов: каждый сам отмечает «Поеду» и число заездов.
export const DEFAULT_MAX_LAPS = 10;
const MAX_LAPS_LIMIT = 30;

export function buildTrainings(rows) {
  const out = [];
  const seen = new Set();
  const int = (v) => parseInt(String(v ?? '').trim(), 10);
  for (const r of rows || []) {
    const id = String(r['ID'] || '').trim();
    const date = parseDate(r['Дата']);
    if (!id || !date || seen.has(id)) continue;
    seen.add(id);
    const kind = String(r['Тип'] || '').trim();
    const max = int(r['Макс. заездов']);
    const maxLaps = max > 0 ? Math.min(max, MAX_LAPS_LIMIT) : DEFAULT_MAX_LAPS;
    const min = int(r['Мин. заездов']);
    out.push({
      id,
      type: 'Тренировка',
      kind,
      championship: String(r['Чемпионат'] || '').trim(),
      title: String(r['Название'] || '').trim() || kind || 'Тренировка',
      date,
      start: parseTime(r['Начало']),
      end: parseTime(r['Окончание']),
      track: String(r['Трасса'] || '').trim(),
      address: String(r['Адрес'] || '').trim(),
      lapCostText: String(r['Стоимость заезда'] || '').trim(),
      lapCost: parseMoney(r['Стоимость заезда']),
      minLaps: min > 0 ? Math.min(min, maxLaps) : 1,
      maxLaps,
      description: String(r['Описание'] || '').trim(),
      cancelled: String(r['Статус'] || '').trim().toLowerCase().startsWith('отмен'),
    });
  }
  return out;
}

// Записи с листа «Записи на тренировки». Если строк на одного пилота несколько, действует последняя.
export function buildSignups(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const pilot = normHandle(r['Пилот']);
    const trainingId = String(r['ID тренировки'] || '').trim();
    const laps = parseInt(String(r['Заездов'] || '').trim(), 10);
    if (!pilot || !trainingId || !(laps > 0)) continue;
    map.set(pilot + '|' + trainingId, { id: String(r['ID'] || '').trim(), pilot, trainingId, laps });
  }
  return [...map.values()];
}

// Проверка записи: тренировка есть, не отменена, заездов от минимума до максимума.
export function canSignTraining(trainings, trainingId, laps) {
  const t = trainings.find((x) => x.id === trainingId);
  if (!t || t.cancelled) return 'no_training';
  if (!/^\d+$/.test(String(laps).trim()) || +laps < t.minLaps || +laps > t.maxLaps) return 'bad_laps';
  return '';
}

const lapsWord = (n) =>
  n % 10 === 1 && n % 100 !== 11 ? 'заезд' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'заезда' : 'заездов';

// Траты на тренировки: стоимость заезда × число заездов.
export function buildTrainingSpent(trainings, signups, person) {
  const byId = new Map(trainings.map((t) => [t.id, t]));
  const items = [];
  for (const s of signups) {
    if (!person.keys.includes(s.pilot)) continue;
    const t = byId.get(s.trainingId);
    if (!t || t.cancelled || !t.lapCost) continue;
    items.push({
      raceId: t.id,
      title: t.title,
      date: isoDate(t.date),
      category: 'Тренировки',
      amount: Math.round(t.lapCost * s.laps * 100) / 100,
      fullCost: 0,
      split: 0,
      laps: s.laps,
      lapCost: t.lapCost,
      note: '',
    });
  }
  return items;
}

// ---- Архив ----
// Строки старше недели скрипт переносит на листы-архивы, чтобы основные листы
// не разрастались. Приложение читает оба листа; при совпадении ID главнее основной.
export const ARCHIVE_AFTER_DAYS = 7;

function withArchive(main, archived) {
  const ids = new Set(main.map((e) => e.id));
  return [...main, ...archived.filter((e) => !ids.has(e.id))];
}

export function eventsWithArchive(data) {
  return withArchive(buildEvents(data['События']), buildEvents(data['Архив событий']));
}

export function trainingsWithArchive(data) {
  return withArchive(buildTrainings(data['Тренировки']), buildTrainings(data['Архив тренировок']));
}

// ID событий, прошедших больше `days` дней назад (todayIso — «ГГГГ-ММ-ДД»).
export function staleIds(items, todayIso, days) {
  const [y, m, d] = todayIso.split('-').map(Number);
  const c = new Date(Date.UTC(y, m - 1, d - days));
  const cutoff = isoDate({ y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() });
  return new Set(items.filter((e) => isoDate(e.date) < cutoff).map((e) => e.id));
}

// ---- Напоминания ----
// Настройки человека хранятся на листе «Настройки уведомлений», по строке на человека.
// «За сколько»: «2 дн» (за N дней) или «01:30» (за чч:мм до начала).
export const DEFAULT_LEAD = { races: '1 дн', trainings: '02:00' };

export function parseLead(v) {
  const s = String(v ?? '').trim().toLowerCase();
  let m = s.match(/^(\d{1,2})\s*д/);
  if (m) {
    const days = +m[1];
    return days >= 1 && days <= 30 ? { mode: 'days', days, minutes: days * 1440, text: `${days} дн` } : null;
  }
  m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) {
    const h = +m[1];
    const min = +m[2];
    if (h > 23 || min > 59 || h * 60 + min < 5) return null;
    return { mode: 'time', h, min, minutes: h * 60 + min, text: `${pad(h)}:${pad(min)}` };
  }
  return null;
}

export function findSettings(rows, person) {
  let found = null;
  for (const r of rows || []) {
    if (person.keys.includes(normHandle(r['Пользователь']))) found = r;
  }
  const part = (on, lead, def) => ({ on: isYes(on), lead: (parseLead(lead) || parseLead(def)).text });
  return {
    races: part(found && found['Гонки'], found && found['Гонки за'], DEFAULT_LEAD.races),
    trainings: part(found && found['Тренировки'], found && found['Тренировки за'], DEFAULT_LEAD.trainings),
    chatId: found ? String(found['Telegram ID'] || '').trim() : '',
  };
}

// Начало события в миллисекундах. Время — московское (UTC+3, без перехода на летнее);
// если время не указано, считаем от 09:00.
export function startMs(date, start) {
  const t = start || { h: 9, min: 0 };
  return Date.UTC(date.y, date.m - 1, date.d, t.h - 3, t.min);
}

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const html = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function untilText(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins >= 1440) {
    const d = Math.round(mins / 1440);
    return `${d} ${d % 10 === 1 && d % 100 !== 11 ? 'день' : [2, 3, 4].includes(d % 10) && ![12, 13, 14].includes(d % 100) ? 'дня' : 'дней'}`;
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [h ? `${h} ч` : '', m ? `${m} мин` : ''].filter(Boolean).join(' ') || 'несколько минут';
}

function reminderText(item, nowMs) {
  const d = item.date;
  const wd = WEEKDAYS_SHORT[new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay()];
  const time = item.start ? ` · ${pad(item.start.h)}:${pad(item.start.min)}` : '';
  const lines = [
    `⏰ <b>${item.category === 'races' ? 'Скоро гонка' : 'Скоро тренировка'}</b> — через ${untilText(item.at - nowMs)}`,
    '',
    `<b>${html(item.title)}</b>`,
    `${d.d} ${MONTHS_GEN[d.m - 1]}, ${wd}${time}`,
  ];
  if (item.track) lines.push(`Трасса: ${html(item.track)}`);
  if (item.role) lines.push(html(item.role));
  return lines.join('\n');
}

// Какие напоминания пора отправить. `sent` — ключи уже отправленных.
export function dueReminders(data, nowMs, sent) {
  const people = buildPeople(data['Люди']).filter((p) => p.active);
  const events = buildEvents(data['События']);
  const trainings = buildTrainings(data['Тренировки']);
  const signups = buildSignups(data['Записи на тренировки']);
  const out = [];
  const seenPeople = new Set();
  for (const p of people) {
    if (seenPeople.has(p.key)) continue;
    seenPeople.add(p.key);
    const st = findSettings(data['Настройки уведомлений'], p);
    if (!/^\d+$/.test(st.chatId) || (!st.races.on && !st.trainings.on)) continue;

    const items = [];
    for (const e of events) {
      if (e.cancelled) continue;
      const crew = e.crews.find((c) => inCrew(c, p));
      if (!crew) continue;
      const roles = [listsPerson(crew.pilots, p) && 'пилот', listsPerson(crew.managers, p) && 'менеджер'].filter(Boolean).join(', ');
      items.push({
        ...e,
        category: /трен/i.test(e.type) ? 'trainings' : 'races',
        role: `Вы: ${roles}${crew.name ? ` (${crew.name})` : ''}`,
      });
    }
    for (const t of trainings) {
      if (t.cancelled) continue;
      const s = signups.find((x) => x.trainingId === t.id && p.keys.includes(x.pilot));
      if (s) items.push({ ...t, category: 'trainings', role: `Вы едете: ${s.laps} ${lapsWord(s.laps)}` });
    }

    for (const it of items) {
      const conf = st[it.category];
      if (!conf.on) continue;
      const lead = parseLead(conf.lead);
      const at = startMs(it.date, it.start);
      if (nowMs < at - lead.minutes * 60000 || nowMs >= at) continue;
      const key = [p.key, it.category, it.id, at, lead.minutes].join('|');
      if (sent.has(key)) continue;
      out.push({ chatId: st.chatId, key, text: reminderText({ ...it, at }, nowMs) });
    }
  }
  return out;
}

// Назначения на гонки: кто, в какую гонку и на какую роль. Только предстоящие и не отменённые.
// Ключ «гонка|человек|роль» — по нему видно, о каком назначении человек уже знает.
// chatIds — известные Telegram ID людей (из приложения), если в «Людях» указан только ник.
export function currentAssignments(data, nowMs, chatIds = {}) {
  const people = buildPeople(data['Люди']).filter((p) => p.active);
  const settings = data['Настройки уведомлений'];
  const out = [];
  const seen = new Set();
  for (const e of buildEvents(data['События'])) {
    if (e.cancelled || nowMs >= startMs(e.date, e.start)) continue;
    for (const p of people) {
      if (seen.has(e.id + '|' + p.key)) continue;
      const crew = e.crews.find((c) => inCrew(c, p));
      if (!crew) continue;
      seen.add(e.id + '|' + p.key);
      const roles = [listsPerson(crew.pilots, p) && 'pilot', listsPerson(crew.managers, p) && 'manager'].filter(Boolean);
      const chatId =
        p.keys.find((k) => /^\d+$/.test(k)) || findSettings(settings, p).chatId || String(chatIds[p.key] || '');
      out.push({ event: e, person: p, crew: crew.name, roles, chatId: /^\d+$/.test(chatId) ? chatId : '', keys: roles.map((r) => [e.id, p.key, r].join('|')) });
    }
  }
  return out;
}

const ROLE_ACC = { pilot: 'пилот', manager: 'менеджер' };

function assignmentText(a, roles) {
  const e = a.event;
  const d = e.date;
  const wd = WEEKDAYS_SHORT[new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay()];
  const time = e.start ? ` · ${pad(e.start.h)}:${pad(e.start.min)}` : '';
  const where = /трен/i.test(e.type) ? 'на тренировку' : 'на гонку';
  const lines = [
    `🏁 <b>Вы назначены ${where}</b>`,
    '',
    `Роль: <b>${roles.map((r) => ROLE_ACC[r]).join(' и ')}</b>${a.crew ? ` (состав ${html(a.crew)})` : ''}`,
    `${/трен/i.test(e.type) ? 'Тренировка' : 'Гонка'}: <b>${html(e.title)}</b>`,
    `Дата: ${d.d} ${MONTHS_GEN[d.m - 1]} ${d.y}, ${wd}${time}`,
  ];
  if (e.track) lines.push(`Трасса: ${html(e.track)}`);
  return lines.join('\n');
}

// Сообщения о новых назначениях. `notified` — ключи назначений, о которых уже сообщили.
// Кому некуда писать (ещё ни разу не открывал приложение), тому сообщим позже.
export function newAssignments(assignments, notified) {
  const out = [];
  for (const a of assignments) {
    const fresh = a.roles.filter((r, i) => !notified.has(a.keys[i]));
    if (!fresh.length || !a.chatId) continue;
    out.push({
      chatId: a.chatId,
      keys: a.roles.map((r, i) => (fresh.includes(r) ? a.keys[i] : '')).filter(Boolean),
      text: assignmentText(a, fresh),
      who: a.person.name,
      title: a.event.title,
    });
  }
  return out;
}

// Сборка ответа для экрана приложения.
export function buildView(data, tgUser, timezone) {
  const allEvents = eventsWithArchive(data);
  const people = buildPeople(data['Люди']);
  const person = findPerson(people, tgUser);
  if (!person || !person.active) {
    return {
      access: false,
      username: tgUser?.username || null,
      telegramId: tgUser?.id ?? null,
    };
  }

  const byKey = new Map();
  for (const p of people) for (const k of p.keys) byKey.set(k, p);
  const nameOf = (k) => byKey.get(k)?.name || (/^\d+$/.test(k) ? 'ID ' + k : '@' + k);
  const personCard = (k) => {
    const p = byKey.get(k);
    return { handle: p ? p.handle : /^\d+$/.test(k) ? '' : k, name: nameOf(k), phone: p?.phone || '', me: p === person };
  };

  const events = visibleEvents(allEvents, person)
    .map((e) => ({
      id: e.id,
      type: e.type,
      format: e.format,
      championship: e.championship,
      stage: e.stageLabel,
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
      // Роль открывшего приложение именно в этой гонке.
      myRoles: [
        e.crews.some((c) => listsPerson(c.pilots, person)) && 'pilot',
        e.crews.some((c) => listsPerson(c.managers, person)) && 'manager',
      ].filter(Boolean),
      crews: e.crews.map((c) => ({
        name: c.name,
        pilots: c.pilots.map(personCard),
        managers: c.managers.map(personCard),
        mine: inCrew(c, person),
      })),
    }))
    .sort(byWhen);

  // Открытые тренировки видят все, у кого есть доступ.
  const trainings = trainingsWithArchive(data);
  const signups = buildSignups(data['Записи на тренировки']);
  const openTrainings = trainings
    .map((t) => {
      const going = signups.filter((s) => s.trainingId === t.id);
      const mine = going.find((s) => person.keys.includes(s.pilot));
      const calEvent = {
        ...t,
        type: t.kind || t.type,
        stageLabel: '',
        format: '',
        cost: t.lapCostText ? `${t.lapCostText} за заезд` + (mine ? `, ${mine.laps} ${lapsWord(mine.laps)}` : '') : '',
        rules: '',
        crews: [],
      };
      return {
        id: t.id,
        title: t.title,
        kind: t.kind,
        championship: t.championship,
        date: isoDate(t.date),
        start: t.start ? `${pad(t.start.h)}:${pad(t.start.min)}` : '',
        end: t.end ? `${pad(t.end.h)}:${pad(t.end.min)}` : '',
        track: t.track,
        address: t.address,
        lapCost: t.lapCost,
        lapCostText: t.lapCostText,
        minLaps: t.minLaps,
        maxLaps: t.maxLaps,
        description: t.description,
        cancelled: t.cancelled,
        calendarUrl: googleCalendarUrl(calEvent, timezone, nameOf),
        myLaps: mine ? mine.laps : 0,
        going: going.map((s) => ({ ...personCard(s.pilot), laps: s.laps })),
      };
    })
    .sort(byWhen);

  const races = managedRaces(allEvents, person);
  return {
    access: true,
    me: { name: person.name, key: person.key, roles: person.roles },
    events,
    trainings: openTrainings,
    settings: (({ races, trainings: tr }) => ({ races, trainings: tr }))(findSettings(data['Настройки уведомлений'], person)),
    finance: {
      spent: [...buildSpent(allEvents, person), ...buildTrainingSpent(trainings, signups, person)],
      earned: buildEarned(allEvents, person, data['Заработок']),
      // Блок «Заработано» — для менеджеров и тех, кого вписали менеджером гонки.
      canEarn: person.roles.manager || races.length > 0,
      managedRaces: races,
    },
    updatedAt: data.updatedAt || null,
  };
}
