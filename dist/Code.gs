// M-ELVN Mini App — код для Google Apps Script (Расширения → Apps Script).
// Файл собран автоматически из src/logic.js и src/gas-main.js, правьте исходники.
// Токен бота задаётся один раз: Настройки проекта → Свойства скрипта → BOT_TOKEN.

// Точка входа Google Apps Script. Собирается вместе с logic.js в dist/Code.gs.
// Приложение вызывает: GET <URL веб-приложения>?initData=<Telegram.WebApp.initData>
// Запись дохода менеджером: те же параметры + action=addIncome&raceId=&amount=&note=
// Удаление своей записи: action=deleteIncome&id=

// Токен бота хранится в свойствах скрипта (Настройки проекта → Свойства скрипта → BOT_TOKEN),
// чтобы при обновлении кода его не нужно было вписывать заново.
function botToken() {
  return PropertiesService.getScriptProperties().getProperty('BOT_TOKEN') || '';
}

const TIMEZONE = 'Europe/Moscow';
const SHEETS = ['Люди', 'События', 'Заработок'];
const INCOME_SHEET = 'Заработок';
const INCOME_HEADERS = ['ID', 'Дата записи', 'Менеджер', 'ID гонки', 'Сумма', 'Комментарий'];
// Подпись Telegram действует сутки: перехваченную ссылку нельзя использовать долго.
const MAX_AUTH_AGE_SECONDS = 24 * 3600;
const MAX_INCOME = 10000000;
const MAX_WRITES_PER_HOUR = 30;

function doGet(e) {
  const initData = (e && e.parameter && e.parameter.initData) || '';
  const user = verifyInitData(initData, botToken());
  if (!user) return jsonOut({ error: 'not_telegram' });
  try {
    const action = e.parameter.action || '';
    if (action === 'addIncome' || action === 'deleteIncome') {
      const result = changeIncome(action, e.parameter, user);
      if (result) return jsonOut(result);
    }
    return jsonOut(buildView(readSheets(), user, TIMEZONE));
  } catch (err) {
    // Подробности ошибки — только в журнал скрипта, наружу не отдаём.
    console.error(err);
    return jsonOut({ error: 'sheet_unavailable' });
  }
}

// Строка 1 — заголовки, строка 2 — подсказки (пропускается), данные с 3-й строки.
function readSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = { updatedAt: new Date().toISOString() };
  SHEETS.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) { out[name] = []; return; }
    const values = sh.getDataRange().getDisplayValues();
    const headers = values[0].map(function (h) { return String(h).trim(); });
    out[name] = values.slice(2)
      .filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); })
      .map(function (r) {
        const row = {};
        headers.forEach(function (h, i) { if (h) row[h] = String(r[i]).trim(); });
        return row;
      });
  });
  return out;
}

// Запись или удаление дохода. Возвращает объект с ошибкой или null при успехе.
function changeIncome(action, p, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = readSheets();
    const person = findPerson(buildPeople(data['Люди']), user);
    if (!person || !person.active) return { error: 'no_access' };
    if (!allowWrite(person.key)) return { error: 'too_many' };
    const sh = incomeSheet();

    if (action === 'addIncome') {
      const raceId = String(p.raceId || '').trim();
      const amount = /^\s*-/.test(String(p.amount || '')) ? 0 : parseMoney(p.amount);
      if (!(amount > 0 && amount <= MAX_INCOME)) return { error: 'bad_amount' };
      if (!canAddIncome(buildEvents(data['События']), person, raceId)) return { error: 'not_manager' };
      const note = safeCell(String(p.note || '').slice(0, 200));
      sh.appendRow([Utilities.getUuid(), new Date().toISOString(), safeCell(person.key), safeCell(raceId), amount, note]);
      return null;
    }

    // deleteIncome: удалить можно только свою запись.
    const id = String(p.id || '').trim();
    const values = sh.getDataRange().getDisplayValues();
    for (let i = values.length - 1; i >= 2; i--) {
      if (values[i][0] === id && person.keys.includes(normHandle(values[i][2]))) {
        sh.deleteRow(i + 1);
        return null;
      }
    }
    return { error: 'not_found' };
  } finally {
    lock.releaseLock();
  }
}

// Текст, начинающийся с = + - @, Google Таблицы считают формулой. Апостроф
// в начале заставляет сохранить его как обычный текст.
function safeCell(v) {
  const s = String(v).replace(/[\u0000-\u001f]/g, ' ');
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// Не больше MAX_WRITES_PER_HOUR записей и удалений в час от одного человека.
function allowWrite(key) {
  const cache = CacheService.getScriptCache();
  const k = 'w:' + key;
  const n = Number(cache.get(k) || 0);
  if (n >= MAX_WRITES_PER_HOUR) return false;
  cache.put(k, String(n + 1), 3600);
  return true;
}

// Лист «Заработок» создаётся сам при первой записи.
function incomeSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(INCOME_SHEET);
  if (!sh) {
    sh = ss.insertSheet(INCOME_SHEET);
    sh.appendRow(INCOME_HEADERS);
    sh.appendRow(['Заполняется из приложения', 'Не редактировать вручную без нужды', 'Ник или ID', 'ID из «Событий»', 'Рубли', '']);
    sh.setFrozenRows(2);
  }
  return sh;
}

// Проверка подписи initData:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = {};
  String(initData).split('&').forEach(function (pair) {
    const i = pair.indexOf('=');
    if (i < 0) return;
    const key = decodeURIComponent(pair.slice(0, i).replace(/\+/g, ' '));
    params[key] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
  });
  const hash = params.hash;
  if (!hash) return null;
  delete params.hash;

  const checkString = Object.keys(params)
    .map(function (k) { return k + '=' + params[k]; })
    .sort()
    .join('\n');
  // computeHmacSha256Signature(value, key)
  const secret = Utilities.computeHmacSha256Signature(utf8(botToken), utf8('WebAppData'));
  const expected = toHex(Utilities.computeHmacSha256Signature(utf8(checkString), secret));
  if (expected !== hash) return null;

  const authDate = Number(params.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE_SECONDS) return null;

  try {
    return JSON.parse(params.user || 'null');
  } catch (err) {
    return null;
  }
}

function utf8(s) {
  return Utilities.newBlob(String(s)).getBytes();
}

function toHex(bytes) {
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Чистая логика: разбор данных таблицы, роли, видимость, ссылки на календарь.
// Работает и в Node (тесты), и в Google Apps Script (scripts/build-gas.mjs убирает `export`).

const YES = new Set(['да', 'yes', 'true', '1', '+', 'x', 'х']);

function isYes(v) {
  return YES.has(String(v ?? '').trim().toLowerCase());
}

// Ник или числовой Telegram ID, без @ и в нижнем регистре.
function normHandle(v) {
  return String(v ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').toLowerCase();
}

function splitHandles(v) {
  return String(v ?? '')
    .split(/[,;\n]+/)
    .map(normHandle)
    .filter(Boolean);
}

// «15.11.2026» или «2026-11-15» → {y, m, d}
function parseDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  return null;
}

// «10:00» или «10:00:00» → {h, min}
function parseTime(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2})[:.](\d{2})/);
  return m ? { h: +m[1], min: +m[2] } : null;
}

const pad = (n) => String(n).padStart(2, '0');

// Человека можно указать ником или числовым Telegram ID — подходят оба.
function buildPeople(rows) {
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
function parseFormat(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.startsWith('команд')) return 'team';
  if (s.startsWith('личн')) return 'solo';
  return '';
}

// Этап «3» → «Этап 3» у гонки и «Тренировка 3» у тренировки; текст — как есть.
function stageLabel(stage, type) {
  if (!/^\d+$/.test(stage)) return stage;
  return (/трен/i.test(type) ? 'Тренировка ' : 'Этап ') + stage;
}

// Составы указываются прямо в таблице событий. Одна строка — один состав.
// Если в гонке несколько составов, добавляется ещё строка с тем же ID:
// в ней достаточно заполнить «Состав», «Менеджер» и «Пилоты», остальное
// берётся из первой строки события.
function buildEvents(eventRows) {
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

function findPerson(people, tgUser) {
  const keys = new Set();
  if (tgUser?.username) keys.add(normHandle(tgUser.username));
  if (tgUser?.id) keys.add(String(tgUser.id));
  return people.find((p) => p.keys.some((k) => keys.has(k))) || null;
}

const listsPerson = (list, person) => list.some((k) => person.keys.includes(k));

const inCrew = (c, person) => listsPerson(c.pilots, person) || listsPerson(c.managers, person);

// Руководство видит всё; остальные — только события, где их вписали
// пилотом или менеджером хотя бы одного состава. Все составы гонки видны.
function visibleEvents(events, person) {
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

const FORMAT_LABEL = { team: 'Командная', solo: 'Личная' };

function calendarDetails(event, nameOf) {
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

function googleCalendarUrl(event, timezone, nameOf = (h) => '@' + h) {
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
function parseMoney(v) {
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
function financeCategory(e) {
  if (/трен/i.test(e.type)) return 'Тренировки';
  return e.championship || 'Без чемпионата';
}

const isoDate = (d) => `${d.y}-${pad(d.m)}-${pad(d.d)}`;

// Траты пилота: «Стоимость» каждой его (не отменённой) гонки. В командной
// гонке она делится на число пилотов его состава.
function buildSpent(events, person) {
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
function buildEarned(events, person, incomeRows) {
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
function managedRaces(events, person) {
  return events
    .filter((e) => e.crews.some((c) => listsPerson(c.managers, person)))
    .map((e) => ({ id: e.id, title: e.title, date: isoDate(e.date) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function canAddIncome(events, person, raceId) {
  const e = events.find((x) => x.id === raceId);
  return !!e && e.crews.some((c) => listsPerson(c.managers, person));
}

// Сборка ответа для экрана приложения.
function buildView(data, tgUser, timezone) {
  const allEvents = buildEvents(data['События']);
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
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  const races = managedRaces(allEvents, person);
  return {
    access: true,
    me: { name: person.name, roles: person.roles },
    events,
    finance: {
      spent: buildSpent(allEvents, person),
      earned: buildEarned(allEvents, person, data['Заработок']),
      // Блок «Заработано» — для менеджеров и тех, кого вписали менеджером гонки.
      canEarn: person.roles.manager || races.length > 0,
      managedRaces: races,
    },
    updatedAt: data.updatedAt || null,
  };
}
