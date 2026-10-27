import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac } from 'node:crypto';
import { buildView, googleCalendarUrl, buildEvents, parseDate, parseMoney, dueReminders, parseLead, currentAssignments, newAssignments } from '../src/logic.js';

const data = {
  'Люди': [
    { Telegram: 'ivan_petrov', 'Имя': 'Иван Петров', 'Пилот': 'Да', 'Менеджер': 'Нет', 'Руководство': 'Нет', 'Активен': 'Да' },
    { Telegram: '@Anna_Smirnova', 'Telegram ID': '555', 'Имя': 'Анна', 'Пилот': 'Да', 'Активен': 'Да' },
    { Telegram: 'max_kart', 'Имя': 'Максим', 'Пилот': 'Да', 'Активен': 'Нет' },
    { Telegram: 'oleg_manager', 'Имя': 'Олег', 'Пилот': 'Да', 'Менеджер': 'Да', 'Активен': 'Да' },
    { Telegram: 'melvn_boss', 'Имя': 'Босс', 'Руководство': 'Да', 'Активен': 'Да' },
    { Telegram: '', 'Telegram ID': '123456', 'Имя': 'Без ника', 'Пилот': 'Да', 'Активен': '' },
  ],
  'События': [
    { ID: 'R1', 'Тип': 'Гонка', 'Формат': 'Командная', 'Чемпионат': 'Кубок Москвы', 'Этап': '3', 'Название': 'Этап 3', 'Дата': '15.11.2026', 'Начало': '10:00', 'Окончание': '18:00', 'Трасса': 'Картодром', 'Стоимость': '10 000 ₽', 'Состав': 'M-ELVN Orange', 'Менеджер': 'oleg_manager', 'Пилоты': 'ivan_petrov, 555' },
    { ID: 'R1', 'Состав': 'M-ELVN Carbon', 'Менеджер': 'melvn_boss', 'Пилоты': 'kirill' },
    { ID: 'R3', 'Тип': 'Гонка', 'Формат': 'Командная', 'Название': 'Только второй состав', 'Дата': '06.12.2026', 'Состав': 'A', 'Пилоты': 'someone' },
    { ID: 'R3', 'Состав': 'B', 'Менеджер': 'oleg_manager', 'Пилоты': 'kirill' },
    { ID: 'R2', 'Тип': 'Гонка', 'Формат': 'Личная', 'Чемпионат': 'RMC', 'Этап': 'Финал', 'Название': '', 'Дата': '22.11.2026', 'Начало': '11:00', 'Стоимость': '5000', 'Менеджер': '', 'Пилоты': 'max_kart; oleg_manager' },
    { ID: 'T1', 'Тип': 'Тренировка', 'Название': 'Тренировка', 'Дата': '08.11.2026', 'Стоимость': '3000', 'Статус': 'Отменено', 'Пилоты': 'anna_smirnova, 123456' },
    { ID: 'X1', 'Тип': 'Гонка', 'Название': 'Чужая гонка', 'Дата': '29.11.2026', 'Пилоты': 'someone_else' },
    { ID: 'BAD', 'Тип': 'Гонка', 'Название': 'Без даты', 'Дата': '' },
  ],
};

const ids = (v) => v.events.map((e) => e.id).sort();

test('pilot sees only races the admin put them in', () => {
  const v = buildView(data, { id: 1, username: 'Ivan_Petrov' }, 'Europe/Moscow');
  assert.equal(v.access, true);
  assert.deepEqual(ids(v), ['R1']);
  const [mine, other] = v.events[0].crews;
  assert.equal(mine.name, 'M-ELVN Orange');
  assert.deepEqual(mine.pilots.map((p) => p.name), ['Иван Петров', 'Анна']);
  assert.equal(mine.pilots[0].me, true);
  assert.equal(mine.mine, true);
  assert.equal(other.name, 'M-ELVN Carbon');
  assert.equal(other.mine, false);
  assert.equal(other.pilots[0].name, '@kirill');
  assert.equal(v.events[0].format, 'team');
});

test('several crews: extra rows with the same ID add crews, not events', () => {
  const events = buildEvents(data['События']);
  assert.deepEqual(events.map((e) => e.id), ['R1', 'R3', 'R2', 'T1', 'X1']);
  assert.equal(events[0].crews.length, 2);
  assert.equal(events[0].title, 'Этап 3');
});

test('championship and stage are passed through; title falls back to them', () => {
  const v = buildView(data, { username: 'oleg_manager' });
  const r1 = v.events.find((e) => e.id === 'R1');
  assert.equal(r1.championship, 'Кубок Москвы');
  assert.equal(r1.stage, 'Этап 3');
  const r2 = v.events.find((e) => e.id === 'R2');
  assert.equal(r2.title, 'RMC — Финал');
  assert.match(decodeURIComponent(r1.calendarUrl), /Чемпионат: Кубок Москвы — Этап 3/);
});

test('training numbered stage becomes "Championship — Тренировка N"', () => {
  const [e] = buildEvents([{ ID: 'T9', 'Тип': 'Тренировка', 'Чемпионат': 'Rotax', 'Этап': '2', 'Дата': '01.12.2026' }]);
  assert.equal(e.title, 'Rotax — Тренировка 2');
  const [f] = buildEvents([{ ID: 'T8', 'Тип': 'Тренировка', 'Чемпионат': 'Rotax', 'Этап': 'Тренировка 5', 'Дата': '01.12.2026' }]);
  assert.equal(f.title, 'Rotax — Тренировка 5');
});

test('myRoles shows the viewer\'s role in each race', () => {
  const oleg = buildView(data, { username: 'oleg_manager' });
  const byId = Object.fromEntries(oleg.events.map((e) => [e.id, e.myRoles]));
  assert.deepEqual(byId.R1, ['manager']);
  assert.deepEqual(byId.R2, ['pilot']);
  const ivan = buildView(data, { username: 'ivan_petrov' });
  assert.deepEqual(ivan.events[0].myRoles, ['pilot']);
  const boss = buildView(data, { username: 'melvn_boss' });
  assert.deepEqual(boss.events.find((e) => e.id === 'R1').myRoles, ['manager']);
  assert.deepEqual(boss.events.find((e) => e.id === 'X1').myRoles, []);
});

test('manager of the second crew sees the race', () => {
  const v = buildView(data, { username: 'oleg_manager' });
  const r3 = v.events.find((e) => e.id === 'R3');
  assert.ok(r3);
  assert.deepEqual(r3.crews.map((c) => c.mine), [false, true]);
});

test('manager sees races where they are manager or pilot, not all races', () => {
  const v = buildView(data, { id: 2, username: 'oleg_manager' });
  assert.deepEqual(ids(v), ['R1', 'R2', 'R3']);
});

test('leadership sees every race with a valid date', () => {
  const v = buildView(data, { id: 3, username: 'melvn_boss' });
  assert.deepEqual(ids(v), ['R1', 'R2', 'R3', 'T1', 'X1']);
});

test('participants can be listed by nick or by Telegram ID', () => {
  const anna = buildView(data, { id: 555 });
  assert.equal(anna.access, true);
  assert.deepEqual(ids(anna), ['R1', 'T1']);
  const noNick = buildView(data, { id: 123456 });
  assert.deepEqual(ids(noNick), ['T1']);
  assert.equal(noNick.events[0].cancelled, true);
});

test('inactive or unknown person has no access', () => {
  assert.equal(buildView(data, { id: 4, username: 'max_kart' }).access, false);
  const v = buildView(data, { id: 5, username: 'stranger' });
  assert.equal(v.access, false);
  assert.equal(v.username, 'stranger');
});

test('events are sorted by date', () => {
  const v = buildView(data, { username: 'melvn_boss' });
  assert.deepEqual(v.events.map((e) => e.id), ['T1', 'R1', 'R2', 'X1', 'R3']);
});

test('calendar link: timed and all-day, with participants', () => {
  const [r1, , , t1] = buildEvents(data['События']);
  const u = new URL(googleCalendarUrl(r1, 'Europe/Moscow'));
  assert.equal(u.searchParams.get('dates'), '20261115T100000/20261115T180000');
  assert.equal(u.searchParams.get('ctz'), 'Europe/Moscow');
  assert.match(u.searchParams.get('details'), /Гонка, Командная/);
  assert.match(u.searchParams.get('details'), /M-ELVN Orange:\nПилоты: @ivan_petrov, @555\nМенеджер: @oleg_manager/);
  assert.match(u.searchParams.get('details'), /M-ELVN Carbon:/);
  const a = new URL(googleCalendarUrl(t1, 'Europe/Moscow'));
  assert.equal(a.searchParams.get('dates'), '20261108/20261109');
  assert.equal(a.searchParams.get('ctz'), null);
});

test('calendar all-day across month end', () => {
  const [e] = buildEvents([{ ID: 'X', 'Дата': '31.12.2026' }]);
  assert.equal(new URL(googleCalendarUrl(e)).searchParams.get('dates'), '20261231/20270101');
});

test('parseDate formats', () => {
  assert.deepEqual(parseDate('5.1.2027'), { y: 2027, m: 1, d: 5 });
  assert.equal(parseDate('завтра'), null);
});

test('parseMoney understands spaces, dots and commas', () => {
  assert.equal(parseMoney('7 000 ₽ с пилота'), 7000);
  assert.equal(parseMoney('10.000'), 10000);
  assert.equal(parseMoney('1 500,50'), 1500.5);
  assert.equal(parseMoney('7 000,00 ₽'), 7000);
  assert.equal(parseMoney('бесплатно'), 0);
});

test('spent: team race cost is split between the pilots of my crew, solo is full', () => {
  const ivan = buildView(data, { username: 'ivan_petrov' }).finance;
  assert.deepEqual(ivan.spent.map((x) => [x.raceId, x.amount]), [['R1', 5000]]);
  assert.equal(ivan.spent[0].category, 'Кубок Москвы');
  const oleg = buildView(data, { username: 'oleg_manager' }).finance;
  assert.deepEqual(oleg.spent.map((x) => [x.raceId, x.amount, x.category]), [['R2', 5000, 'RMC']]);
  // Одиночный пилот в составе командной гонки платит всё; отменённое не считается.
  const anna = buildView(data, { id: 555 }).finance;
  assert.deepEqual(anna.spent.map((x) => [x.raceId, x.amount]), [['R1', 5000]]);
});

test('earned: only my income rows; managers get the form with their races', () => {
  const d = { ...data, 'Заработок': [
    { ID: 'a', 'Менеджер': 'oleg_manager', 'ID гонки': 'R1', 'Сумма': '4 000', 'Комментарий': 'бонус' },
    { ID: 'b', 'Менеджер': 'melvn_boss', 'ID гонки': 'R1', 'Сумма': '9000' },
  ] };
  const oleg = buildView(d, { username: 'oleg_manager' }).finance;
  assert.deepEqual(oleg.earned.map((x) => [x.id, x.amount, x.category, x.note]), [['a', 4000, 'Кубок Москвы', 'бонус']]);
  assert.equal(oleg.canEarn, true);
  assert.deepEqual(oleg.managedRaces.map((r) => r.id), ['R3', 'R1']);
  const ivan = buildView(d, { username: 'ivan_petrov' }).finance;
  assert.equal(ivan.canEarn, false);
  assert.deepEqual(ivan.earned, []);
});

// Запуск собранного dist/Code.gs в песочнице с заглушками сервисов Google.
function loadGas(botToken, sheets, today = '2026-10-25', user = { active: '', effective: 'owner@gmail.com' }) {
  const cache = {};
  const props = {};
  const fetched = [];
  const responses = []; // коды ответов Telegram по очереди; 'throw' — обрыв связи
  const code = readFileSync(new URL('../dist/Code.gs', import.meta.url), 'utf8');
  const signed = (buf) => [...buf].map((b) => (b > 127 ? b - 256 : b));
  const unsigned = (arr) => Buffer.from(arr.map((b) => (b + 256) % 256));
  const ctx = {
    Utilities: {
      newBlob: (s) => ({ getBytes: () => signed(Buffer.from(s, 'utf8')) }),
      formatDate: (d, tz, fmt) => {
        if (fmt === 'yyyy-MM-dd') return today;
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
          .formatToParts(d).map((x) => [x.type, x.value]));
        return fmt.replace('dd', p.day).replace('MM', p.month).replace('yyyy', p.year).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
      computeHmacSha256Signature: (value, key) => signed(createHmac('sha256', unsigned(key)).update(unsigned(value)).digest()),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k === 'BOT_TOKEN' ? botToken : props[k] ?? null),
        setProperty: (k, v) => (props[k] = v),
      }),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => (sheets[name] ? sheetApi(name) : null),
        getUrl: () => 'https://docs.google.com/spreadsheets/d/x',
        insertSheet: (name) => ((sheets[name] = []), sheetApi(name)),
      }),
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => user.active }),
      getEffectiveUser: () => ({ getEmail: () => user.effective }),
    },
    HtmlService: {
      createHtmlOutput: (html) => ({ html, setTitle() { return this; }, addMetaTag() { return this; } }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cache[k] ?? null,
        put: (k, v) => (cache[k] = v),
        getAll: (keys) => Object.fromEntries(keys.filter((k) => k in cache).map((k) => [k, cache[k]])),
        putAll: (obj) => Object.assign(cache, obj),
        remove: (k) => delete cache[k],
      }),
    },
    console: { error() {}, log() {} },
    UrlFetchApp: {
      fetch: (url, opt) => {
        fetched.push({ url, body: JSON.parse(opt.payload) });
        const r = responses.length ? responses.shift() : 200;
        if (r === 'throw') throw new Error('timeout');
        return { getResponseCode: () => r };
      },
    },
  };
  let uuid = 0;
  ctx.Utilities.getUuid = () => 'id' + ++uuid;
  function sheetApi(name) {
    return {
      getDataRange: () => ({
        // Как в Google Таблицах: апостроф в начале не показывается.
        getDisplayValues: () => sheets[name].map((r) => r.map((v) => String(v).replace(/^'/, ''))),
        getValues: () => sheets[name].map((r) => r.slice()),
      }),
      appendRow: (row) => sheets[name].push(row),
      deleteRow: (n) => sheets[name].splice(n - 1, 1),
      deleteRows: (n, count) => sheets[name].splice(n - 1, count),
      getLastColumn: () => Math.max(0, ...sheets[name].map((r) => r.length)),
      getLastRow: () => sheets[name].reduce((last, r, i) => (r.some((c) => String(c ?? '') !== '') ? i + 1 : last), 0),
      getRange: (row, col, nr, nc) => ({
        getDisplayValues: () =>
          sheets[name].slice(row - 1, row - 1 + nr).map((r) => Array.from({ length: nc }, (_, i) => String(r[col - 1 + i] ?? '').replace(/^'/, ''))),
        setValue: (v) => {
          while (sheets[name].length < row) sheets[name].push([]);
          sheets[name][row - 1][col - 1] = v;
        },
        setValues: (vals) =>
          vals.forEach((rowVals, j) => {
            while (sheets[name].length < row + j) sheets[name].push([]);
            rowVals.forEach((v, i) => (sheets[name][row - 1 + j][col - 1 + i] = v));
          }),
        clearContent: () => {
          for (let j = 0; j < nr; j++) for (let i = 0; i < nc; i++) if (sheets[name][row - 1 + j]) sheets[name][row - 1 + j][col - 1 + i] = '';
        },
      }),
      setFrozenRows() {},
      getFrozenRows: () => 2,
      getMaxRows: () => sheets[name].length,
      insertRowsAfter: (after, n) => sheets[name].push(...Array.from({ length: n }, () => [])),
    };
  }
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const doGet = (params) => JSON.parse(ctx.doGet({ parameter: params }).text);
  doGet.ctx = ctx;
  doGet.fetched = fetched;
  doGet.responses = responses;
  return doGet;
}

function signInitData(botToken, user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'q', user: JSON.stringify(user) });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params;
}

const sheetTable = (rows) => {
  const headers = Object.keys(Object.assign({}, ...rows));
  return [headers, headers.map(() => 'подсказка'), ...rows.map((r) => headers.map((h) => r[h] ?? '')), headers.map(() => '')];
};
const gasSheets = { 'Люди': sheetTable(data['Люди']), 'События': sheetTable(data['События']) };

test('Apps Script: valid initData returns the pilot view', () => {
  const doGet = loadGas('123:ABC', gasSheets);
  const initData = signInitData('123:ABC', { id: 42, username: 'ivan_petrov', first_name: 'Иван' }).toString();
  const v = doGet({ initData });
  assert.equal(v.access, true);
  assert.deepEqual(v.events.map((e) => e.id), ['R1']);
  assert.match(v.events[0].calendarUrl, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
});

test('Apps Script: forged, wrong-token, stale, missing initData or unset token is rejected', () => {
  const doGet = loadGas('123:ABC', gasSheets);
  assert.equal(doGet({}).error, 'not_telegram');
  assert.equal(doGet({ initData: signInitData('123:WRONG', { id: 1, username: 'melvn_boss' }).toString() }).error, 'not_telegram');
  const forged = signInitData('123:ABC', { id: 42, username: 'ivan_petrov' });
  forged.set('user', JSON.stringify({ id: 1, username: 'melvn_boss' }));
  assert.equal(doGet({ initData: forged.toString() }).error, 'not_telegram');
  const old = signInitData('123:ABC', { id: 42, username: 'ivan_petrov' }, 1000);
  assert.equal(doGet({ initData: old.toString() }).error, 'not_telegram');
  const noToken = loadGas(null, gasSheets);
  assert.equal(noToken({ initData: signInitData('', { id: 42, username: 'ivan_petrov' }).toString() }).error, 'not_telegram');
});

test('Apps Script: manager adds and deletes income; others cannot', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  const doGet = loadGas('123:ABC', sheets);
  const as = (username) => signInitData('123:ABC', { id: 7, username }).toString();

  let v = doGet({ initData: as('oleg_manager'), action: 'addIncome', raceId: 'R1', amount: '4 000', note: 'за этап' });
  assert.equal(v.access, true);
  assert.deepEqual(v.finance.earned.map((x) => [x.raceId, x.amount, x.note]), [['R1', 4000, 'за этап']]);
  assert.equal(sheets['Заработок'][0][0], 'ID');

  // Пилот не может записать доход, менеджер — за чужую гонку.
  assert.equal(doGet({ initData: as('ivan_petrov'), action: 'addIncome', raceId: 'R1', amount: '100' }).error, 'not_manager');
  assert.equal(doGet({ initData: as('oleg_manager'), action: 'addIncome', raceId: 'X1', amount: '100' }).error, 'not_manager');
  assert.equal(doGet({ initData: as('oleg_manager'), action: 'addIncome', raceId: 'R1', amount: 'abc' }).error, 'bad_amount');

  const id = v.finance.earned[0].id;
  assert.equal(doGet({ initData: as('melvn_boss'), action: 'deleteIncome', id }).error, 'not_found');
  v = doGet({ initData: as('oleg_manager'), action: 'deleteIncome', id });
  assert.deepEqual(v.finance.earned, []);
});

test('Apps Script: income note cannot inject a formula; amount and rate are limited', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  const doGet = loadGas('123:ABC', sheets);
  const initData = signInitData('123:ABC', { id: 7, username: 'oleg_manager' }).toString();
  doGet({ initData, action: 'addIncome', raceId: 'R1', amount: '100', note: '=IMPORTXML("http://evil","//a")' });
  const row = sheets['Заработок'].at(-1);
  assert.equal(row[5], `'=IMPORTXML("http://evil","//a")`);
  assert.equal(doGet({ initData, action: 'addIncome', raceId: 'R1', amount: '99999999' }).error, 'bad_amount');
  assert.equal(doGet({ initData, action: 'addIncome', raceId: 'R1', amount: '-5' }).error, 'bad_amount');
  let last;
  for (let i = 0; i < 40; i++) last = doGet({ initData, action: 'addIncome', raceId: 'R1', amount: '1' });
  assert.equal(last.error, 'too_many');
});

test('Apps Script: errors do not leak details', () => {
  const doGet = loadGas('123:ABC', { 'Люди': [['Telegram'], ['x'], ['ivan_petrov']], get 'События'() { throw new Error('secret path'); } });
  const v = doGet({ initData: signInitData('123:ABC', { id: 1, username: 'ivan_petrov' }).toString() });
  assert.deepEqual(v, { error: 'sheet_unavailable' });
});

const trainingRows = [
  { ID: 'T1', 'Тип': 'Школа', 'Название': '', 'Дата': '08.11.2026', 'Начало': '12:00', 'Трасса': 'PitStop', 'Стоимость заезда': '1 500 ₽', 'Мин. заездов': '2', 'Макс. заездов': '5' },
  { ID: 'T2', 'Название': 'Вечерняя', 'Дата': '09.11.2026', 'Стоимость заезда': '2000', 'Статус': 'Отменена' },
];

test('trainings: everyone with access sees them; signup laps × lap cost goes to spent', () => {
  const d = { ...data, 'Тренировки': trainingRows, 'Записи на тренировки': [
    { ID: 's1', 'Пилот': 'ivan_petrov', 'ID тренировки': 'T1', 'Заездов': '2' },
    { ID: 's2', 'Пилот': '@Ivan_Petrov', 'ID тренировки': 'T1', 'Заездов': '3' },
    { ID: 's3', 'Пилот': 'ivan_petrov', 'ID тренировки': 'T2', 'Заездов': '4' },
    { ID: 's4', 'Пилот': 'oleg_manager', 'ID тренировки': 'T1', 'Заездов': '1' },
  ] };
  const ivan = buildView(d, { username: 'ivan_petrov' });
  assert.deepEqual(ivan.trainings.map((t) => [t.id, t.title, t.myLaps, t.maxLaps]), [['T1', 'Школа', 3, 5], ['T2', 'Вечерняя', 4, 10]]);
  assert.deepEqual(ivan.trainings[0].going.map((g) => [g.name, g.laps, g.me]), [['Иван Петров', 3, true], ['Олег', 1, false]]);
  // Последняя запись действует, отменённая тренировка в расходы не идёт.
  const tr = ivan.finance.spent.filter((x) => x.category === 'Тренировки');
  assert.deepEqual(tr.map((x) => [x.raceId, x.amount, x.laps, x.lapCost]), [['T1', 4500, 3, 1500]]);
  assert.match(decodeURIComponent(ivan.trainings[0].calendarUrl), /1 500 ₽ за заезд, 3 заезда/);
  // Без листов всё работает как раньше.
  assert.deepEqual(buildView(data, { username: 'ivan_petrov' }).trainings, []);
});

test('Apps Script: pilot signs up for a training, changes laps and cancels', () => {
  const sheets = { ...JSON.parse(JSON.stringify(gasSheets)), 'Тренировки': sheetTable(trainingRows) };
  const doGet = loadGas('123:ABC', sheets);
  const initData = signInitData('123:ABC', { id: 42, username: 'ivan_petrov' }).toString();

  let v = doGet({ initData, action: 'signTraining', trainingId: 'T1', laps: '2' });
  assert.equal(v.trainings[0].myLaps, 2);
  assert.equal(sheets['Записи на тренировки'][0][0], 'ID');
  v = doGet({ initData, action: 'signTraining', trainingId: 'T1', laps: '4' });
  assert.equal(v.trainings[0].myLaps, 4);
  assert.equal(sheets['Записи на тренировки'].length, 3);
  assert.deepEqual(v.finance.spent.filter((x) => x.raceId === 'T1').map((x) => x.amount), [6000]);

  assert.equal(doGet({ initData, action: 'signTraining', trainingId: 'T1', laps: '6' }).error, 'bad_laps');
  assert.equal(doGet({ initData, action: 'signTraining', trainingId: 'T1', laps: '1' }).error, 'bad_laps');
  assert.equal(doGet({ initData, action: 'signTraining', trainingId: 'T1', laps: '=1+1' }).error, 'bad_laps');
  assert.equal(doGet({ initData, action: 'signTraining', trainingId: 'T2', laps: '1' }).error, 'no_training');
  assert.equal(doGet({ initData, action: 'signTraining', trainingId: 'X', laps: '1' }).error, 'no_training');

  // Чужая запись не трогается.
  const boss = signInitData('123:ABC', { id: 1, username: 'melvn_boss' }).toString();
  doGet({ initData: boss, action: 'unsignTraining', trainingId: 'T1' });
  v = doGet({ initData, action: 'unsignTraining', trainingId: 'T1' });
  assert.equal(v.trainings[0].myLaps, 0);
  assert.equal(sheets['Записи на тренировки'].length, 2);
});

test('Apps Script: trainings sheet is created on first open', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  const doGet = loadGas('123:ABC', sheets);
  doGet({ initData: signInitData('123:ABC', { id: 42, username: 'ivan_petrov' }).toString() });
  assert.equal(sheets['Тренировки'][0][8], 'Стоимость заезда');
});

test('Apps Script: missing training columns are added to an existing sheet', () => {
  const sheets = { ...JSON.parse(JSON.stringify(gasSheets)), 'Тренировки': [['ID', 'Дата', 'Трасса'], ['', '', '']] };
  const doGet = loadGas('123:ABC', sheets);
  doGet({ initData: signInitData('123:ABC', { id: 42, username: 'ivan_petrov' }).toString() });
  const h = sheets['Тренировки'][0];
  assert.deepEqual(h.slice(0, 3), ['ID', 'Дата', 'Трасса']);
  assert.ok(h.includes('Тип') && h.includes('Мин. заездов') && h.includes('Макс. заездов'));
  assert.equal(new Set(h).size, h.length);
});

test('events and trainings come in calendar order, nearest first', () => {
  const ev = (ID, d, t) => ({ ID, 'Тип': 'Гонка', 'Дата': d, 'Начало': t, 'Пилоты': 'ivan_petrov' });
  const tr = (ID, d, t) => ({ ID, 'Дата': d, 'Начало': t });
  const d = { ...data,
    'События': [ev('C', '01.12.2026', '10:00'), ev('A', '5.11.2026', ''), ev('B', '05.11.2026', '09:00'), ev('D', '2026-10-30', '')],
    'Тренировки': [tr('t3', '10.12.2026', ''), tr('t1', '02.11.2026', '18:00'), tr('t2', '02.11.2026', '19:00')] };
  const v = buildView(d, { username: 'ivan_petrov' });
  assert.deepEqual(v.events.map((e) => e.id), ['D', 'A', 'B', 'C']);
  assert.deepEqual(v.trainings.map((t) => t.id), ['t1', 't2', 't3']);
});

test('Apps Script: races and trainings older than a week move to archive sheets, app still sees them', () => {
  const sheets = {
    ...JSON.parse(JSON.stringify(gasSheets)),
    'Тренировки': sheetTable([
      { ID: 'T1', 'Дата': '10.10.2026', 'Трасса': 'PitStop', 'Стоимость заезда': '1000' },
      { ID: 'T2', 'Дата': '20.10.2026', 'Трасса': 'PitStop', 'Стоимость заезда': '1000' },
    ]).slice(0, -1),
    'Записи на тренировки': [['ID', 'Дата записи', 'Пилот', 'ID тренировки', 'Заездов'], ['', '', '', '', ''], ['s', '', 'ivan_petrov', 'T1', '2']],
  };
  // R1 (две строки-состава) 15.11.2026 — через месяц после «сегодня» уже старая.
  const doGet = loadGas('123:ABC', sheets, '2026-12-01');
  const initData = signInitData('123:ABC', { id: 42, username: 'ivan_petrov' }).toString();
  const v = doGet({ initData });
  const ids = (rows) => rows.slice(2).map((r) => r[0]).filter(Boolean);
  assert.deepEqual(ids(sheets['События']).filter((x) => x === 'R1'), []);
  assert.deepEqual(ids(sheets['Архив событий']).filter((x) => x === 'R1'), ['R1', 'R1']);
  assert.deepEqual(ids(sheets['Тренировки']), []);
  assert.deepEqual(ids(sheets['Архив тренировок']), ['T1', 'T2']);
  assert.deepEqual(sheets['Архив событий'][0], sheets['События'][0]);
  // В приложении всё на месте, финансы считаются.
  assert.deepEqual(v.events.map((e) => e.id), ['R1']);
  assert.equal(v.events[0].crews.length, 2);
  assert.deepEqual(v.finance.spent.map((x) => [x.raceId, x.amount]), [['R1', 5000], ['T1', 2000]]);
  // Второй раз за день ничего не делает.
  const before = JSON.stringify(sheets);
  doGet({ initData });
  assert.equal(JSON.stringify(sheets), before);
});

test('Apps Script: recent races stay on the main sheet', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  const doGet = loadGas('123:ABC', sheets, '2026-11-20');
  doGet({ initData: signInitData('123:ABC', { id: 42, username: 'ivan_petrov' }).toString() });
  assert.ok(sheets['События'].some((r) => r[0] === 'R1'));
  assert.ok(!(sheets['Архив событий'] || []).some((r) => r[0] === 'R1'));
});

test('reminder lead: days or hh:mm, with limits', () => {
  assert.equal(parseLead('2 дн').minutes, 2880);
  assert.equal(parseLead('01:30').minutes, 90);
  assert.equal(parseLead('1:30:00').text, '01:30');
  assert.equal(parseLead('00:01'), null);
  assert.equal(parseLead('31 дн'), null);
  assert.equal(parseLead('=1'), null);
});

test('reminders: due ones for my races and signed trainings, once', () => {
  const d = { ...data,
    'Тренировки': [{ ID: 'T1', 'Дата': '15.11.2026', 'Начало': '18:00', 'Трасса': 'PitStop' }],
    'Записи на тренировки': [{ 'Пилот': 'ivan_petrov', 'ID тренировки': 'T1', 'Заездов': '3' }],
    'Настройки уведомлений': [{ 'Telegram ID': '42', 'Пользователь': 'ivan_petrov', 'Гонки': 'Да', 'Гонки за': '1 дн', 'Тренировки': 'Да', 'Тренировки за': '01:00' }] };
  // R1: 15.11.2026 10:00 МСК = 07:00 UTC.
  const at = (iso) => Date.parse(iso);
  assert.deepEqual(dueReminders(d, at('2026-11-14T06:59:00Z'), new Set()), []);
  const due = dueReminders(d, at('2026-11-14T07:00:00Z'), new Set());
  assert.equal(due.length, 1);
  assert.equal(due[0].chatId, '42');
  assert.match(due[0].text, /Скоро гонка<\/b> — через 1 день/);
  assert.match(due[0].text, /Вы: пилот \(M-ELVN Orange\)/);
  assert.deepEqual(dueReminders(d, at('2026-11-14T08:00:00Z'), new Set([due[0].key])), []);
  // Тренировка 18:00 МСК = 15:00 UTC, напоминание за час.
  const tr = dueReminders(d, at('2026-11-15T14:10:00Z'), new Set([due[0].key]));
  assert.equal(tr.length, 1);
  assert.match(tr[0].text, /Скоро тренировка<\/b> — через 50 мин/);
  assert.match(tr[0].text, /Вы едете: 3 заезда/);
  // После начала — ничего; выключено — ничего.
  assert.deepEqual(dueReminders(d, at('2026-11-15T15:00:00Z'), new Set()), []);
  const off = { ...d, 'Настройки уведомлений': [{ ...d['Настройки уведомлений'][0], 'Гонки': 'Нет', 'Тренировки': 'Нет' }] };
  assert.deepEqual(dueReminders(off, at('2026-11-14T07:00:00Z'), new Set()), []);
});

test('Apps Script: settings are saved per person and reminders are sent once', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  const doGet = loadGas('123:ABC', sheets);
  const initData = signInitData('123:ABC', { id: 42, username: 'ivan_petrov' }).toString();
  let v = doGet({ initData });
  assert.deepEqual(v.settings, { races: { on: false, lead: '1 дн' }, trainings: { on: false, lead: '02:00' } });
  assert.equal(doGet({ initData, action: 'saveSettings', racesOn: '1', racesLead: '=2', trainingsOn: '0', trainingsLead: '02:00' }).error, 'bad_lead');
  doGet({ initData, action: 'saveSettings', racesOn: '1', racesLead: '3 дн', trainingsOn: '0', trainingsLead: '02:00' });
  v = doGet({ initData, action: 'saveSettings', racesOn: '1', racesLead: '2 дн', trainingsOn: '1', trainingsLead: '00:30' });
  assert.deepEqual(v.settings, { races: { on: true, lead: '2 дн' }, trainings: { on: true, lead: '00:30' } });
  assert.equal(sheets['Настройки уведомлений'].length, 3);

  vm.runInContext("Date.now = () => Date.parse('2026-11-13T08:00:00Z')", doGet.ctx);
  doGet.ctx.sendReminders();
  doGet.ctx.sendReminders();
  assert.equal(doGet.fetched.length, 1);
  assert.match(doGet.fetched[0].url, /\/bot123:ABC\/sendMessage$/);
  assert.equal(doGet.fetched[0].body.chat_id, '42');
  assert.equal(doGet.fetched[0].body.reply_markup.inline_keyboard[0][0].web_app.url, 'https://aliantpt.github.io/melvn-mini-app/');
});

test('Apps Script: failed reminder sends are retried, permanent errors are not', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  const doGet = loadGas('123:ABC', sheets);
  const initData = signInitData('123:ABC', { id: 42, username: 'ivan_petrov' }).toString();
  doGet({ initData, action: 'saveSettings', racesOn: '1', racesLead: '2 дн', trainingsOn: '0', trainingsLead: '02:00' });
  vm.runInContext("Date.now = () => Date.parse('2026-11-13T08:00:00Z')", doGet.ctx);
  const logRows = () => sheets['Журнал уведомлений'].length - 2;

  doGet.responses.push(500, 'throw', 429, 200);
  doGet.ctx.sendReminders(); // 500
  doGet.ctx.sendReminders(); // обрыв
  doGet.ctx.sendReminders(); // 429
  assert.equal(logRows(), 0);
  doGet.ctx.sendReminders(); // 200
  assert.equal(logRows(), 1);
  doGet.ctx.sendReminders(); // уже отправлено
  assert.equal(doGet.fetched.length, 4);

  // 403 (бот заблокирован) — не повторяем.
  const sheets2 = JSON.parse(JSON.stringify(gasSheets));
  const g2 = loadGas('123:ABC', sheets2);
  g2({ initData, action: 'saveSettings', racesOn: '1', racesLead: '2 дн', trainingsOn: '0', trainingsLead: '02:00' });
  vm.runInContext("Date.now = () => Date.parse('2026-11-13T08:00:00Z')", g2.ctx);
  g2.responses.push(403);
  g2.ctx.sendReminders();
  g2.ctx.sendReminders();
  assert.equal(g2.fetched.length, 1);
});

test('Admin: only the owner gets the page and the data', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  const anon = loadGas('123:ABC', sheets);
  assert.match(anon.ctx.doGet({ parameter: { admin: '' } }).html, /Нет доступа/);
  assert.throws(() => anon.ctx.admin_load(), /Нет доступа/);
  assert.throws(() => anon.ctx.admin_replace('Люди', [], [{ Telegram: 'evil', 'Имя': 'x', 'Руководство': 'Да' }]), /Нет доступа/);
  const stranger = loadGas('123:ABC', sheets, undefined, { active: 'someone@gmail.com', effective: 'owner@gmail.com' });
  assert.throws(() => stranger.ctx.admin_load(), /Нет доступа/);
  const owner = loadGas('123:ABC', sheets, undefined, { active: 'owner@gmail.com', effective: 'owner@gmail.com' });
  assert.match(owner.ctx.doGet({ parameter: { admin: '' } }).html, /админ-панель/);
  assert.deepEqual(owner.ctx.admin_load().sheets['Люди'].headers.slice(0, 2), ['Telegram', 'Имя']);
  // Мини-приложение по-прежнему отвечает JSON.
  assert.equal(owner({}).error, 'not_telegram');
});

test('Admin: edits rows in place, adds, deletes and refuses on conflicts', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  const g = loadGas('123:ABC', sheets, undefined, { active: 'owner@gmail.com', effective: 'owner@gmail.com' });
  let d = g.ctx.admin_load();
  const people = d.sheets['Люди'];
  const ivanRow = people.rows.find((r) => r[0] === 'ivan_petrov');
  const obj = Object.fromEntries(people.headers.map((h, i) => [h, ivanRow[i]]));
  const pos = sheets['Люди'].findIndex((r) => r[0] === 'ivan_petrov');

  d = g.ctx.admin_replace('Люди', [ivanRow], [{ ...obj, 'Имя': 'Иван П.', 'Телефон': '+7 900 111-22-33' }]);
  assert.equal(sheets['Люди'][pos][1], 'Иван П.');
  assert.ok(sheets['Люди'][pos].includes("'+7 900 111-22-33"));
  // Та же старая строка второй раз — уже конфликт.
  assert.equal(g.ctx.admin_replace('Люди', [ivanRow], [obj]).error, 'conflict');

  // Новая гонка с двумя составами, затем удаление.
  const before = sheets['События'].length;
  d = g.ctx.admin_replace('События', [], [
    { ID: 'N1', 'Тип': 'Гонка', 'Дата': '01.12.2026', 'Состав': 'A', 'Пилоты': 'ivan_petrov' },
    { ID: 'N1', 'Состав': 'B', 'Пилоты': '555' },
  ]);
  const n1 = d.sheets['События'].rows.filter((r) => r[0] === 'N1');
  assert.equal(n1.length, 2);
  g.ctx.admin_replace('События', n1, []);
  assert.equal(sheets['События'].filter((r) => r[0] === 'N1').length, 0);
  assert.equal(sheets['События'].length, before);

  assert.throws(() => g.ctx.admin_replace('Архив событий', [], [{ ID: 'x' }]), /не меняется/);
  // Формула из поля сохраняется текстом.
  g.ctx.admin_replace('Чемпионаты', [], [{ 'Чемпионат': '=HYPERLINK("x")' }]);
  assert.equal(sheets['Чемпионаты'].at(-1)[0], `'=HYPERLINK("x")`);
});

test('History: app opens, denied access, user actions and admin edits are logged; cleared every 3 days', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  delete sheets['История действий']; // другие тесты пишут в общий gasSheets
  const g = loadGas('123:ABC', sheets, undefined, { active: 'owner@gmail.com', effective: 'owner@gmail.com' });
  const as = (username, id = 7) => signInitData('123:ABC', { id, username }).toString();
  const hist = () => sheets['История действий'].slice(2).map((r) => [r[1], r[2], r[3], r[4]].map((v) => String(v ?? '').replace(/^'/, '')));

  g({ initData: as('ivan_petrov', 42) });
  g({ initData: as('ivan_petrov', 42) }); // повторное открытие в течение 10 минут не пишется
  g({ initData: as('stranger', 99) });
  g({ initData: as('oleg_manager'), action: 'addIncome', raceId: 'R1', amount: '4 000', note: 'за этап' });
  assert.deepEqual(hist(), [
    ['Иван Петров', '@ivan_petrov', 'Открыл приложение', ''],
    ['Не из команды', '@stranger', 'Попытка входа без доступа', 'Нет на листе «Люди» или «Активен» = Нет'],
    ['Олег', '@oleg_manager', 'Внёс заработок', '4000 ₽ — Этап 3 (за этап)'],
  ]);
  assert.match(sheets['История действий'][2][0], /^'\d{2}\.\d{2}\.\d{4} /);

  const d = g.ctx.admin_load();
  const people = d.sheets['Люди'];
  const row = people.rows.find((r) => r[0] === 'ivan_petrov');
  const obj = Object.fromEntries(people.headers.map((h, i) => [h, row[i]]));
  g.ctx.admin_replace('Люди', [row], [{ ...obj, 'Имя': 'Иван П.' }]);
  assert.deepEqual(hist().at(-1), ['Админ-панель', 'owner@gmail.com', 'Админ изменил человека', 'Иван П. — Имя: «Иван Петров» → «Иван П.»']);
  assert.ok(g.ctx.admin_load().sheets['История действий'].rows.length >= 4);

  // Через 3 дня история очищается целиком.
  const later = Date.now() + 3 * 24 * 3600 * 1000 + 1000;
  vm.runInContext('Date.now = () => ' + later, g.ctx);
  g({ initData: signInitData('123:ABC', { id: 555, username: 'anna_smirnova' }, Math.floor(later / 1000)).toString() });
  assert.deepEqual(hist().filter((r) => r.some(Boolean)).map((r) => r[2]), ['Открыл приложение']);
});

test('Apps Script: app view comes from cache until the data changes', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  const g = loadGas('123:ABC', sheets);
  const initData = signInitData('123:ABC', { id: 42, username: 'ivan_petrov' }).toString();
  assert.equal(g({ initData }).me.name, 'Иван Петров');
  // Правка «в обход» без сброса кэша не видна…
  const row = sheets['Люди'].find((r) => r[0] === 'ivan_petrov');
  row[1] = 'Иван Новый';
  assert.equal(g({ initData }).me.name, 'Иван Петров');
  // …а правка руками в таблице (onEdit) сбрасывает кэш.
  g.ctx.onEdit({});
  assert.equal(g({ initData }).me.name, 'Иван Новый');
  // Запись из приложения тоже сбрасывает кэш.
  row[1] = 'Иван Третий';
  const v = g({ initData, action: 'saveSettings', racesOn: '0', racesLead: '1 дн', trainingsOn: '0', trainingsLead: '02:00' });
  assert.equal(v.me.name, 'Иван Третий');
});

test('assignments: who is assigned to which upcoming race, and the message text', () => {
  const now = Date.parse('2026-11-01T08:00:00Z');
  const all = currentAssignments(data, now, { ivan_petrov: '42' });
  const keys = all.flatMap((a) => a.keys).sort();
  // Отменённая T1, прошедшие и неактивные (max_kart) не попадают.
  assert.deepEqual(keys, ['R1|anna_smirnova|pilot', 'R1|ivan_petrov|pilot', 'R1|melvn_boss|manager', 'R1|oleg_manager|manager', 'R2|oleg_manager|pilot', 'R3|oleg_manager|manager']);
  const msgs = newAssignments(all, new Set(['R1|oleg_manager|manager', 'R2|oleg_manager|pilot', 'R3|oleg_manager|manager', 'R1|melvn_boss|manager']));
  // Ивану пишем по ID из приложения, Анне — по ID из «Людей».
  assert.deepEqual(msgs.map((m) => m.chatId).sort(), ['42', '555']);
  const ivan = msgs.find((m) => m.chatId === '42');
  assert.deepEqual(ivan.keys, ['R1|ivan_petrov|pilot']);
  assert.match(ivan.text, /Вы назначены на гонку/);
  assert.match(ivan.text, /Роль: <b>пилот<\/b> \(состав M-ELVN Orange\)/);
  assert.match(ivan.text, /Гонка: <b>Этап 3<\/b>/);
  assert.match(ivan.text, /Дата: 15 ноября 2026, вс · 10:00/);
  // Без известного Telegram ID сообщение ждёт, пока человек откроет приложение.
  assert.equal(newAssignments(currentAssignments(data, now), new Set()).some((m) => m.keys[0] === 'R1|ivan_petrov|pilot'), false);
  // После начала гонки назначение уже не новость.
  assert.equal(currentAssignments(data, Date.parse('2026-11-15T07:00:00Z')).some((a) => a.event.id === 'R1'), false);
});

test('Apps Script: bot tells people about new assignments once, not about old ones', () => {
  const sheets = JSON.parse(JSON.stringify(gasSheets));
  const g = loadGas('123:ABC', sheets);
  const initData = signInitData('123:ABC', { id: 42, username: 'ivan_petrov' }).toString();
  g({ initData }); // Иван открыл приложение — его Telegram ID известен
  vm.runInContext("Date.now = () => Date.parse('2026-11-01T08:00:00Z')", g.ctx);
  // Первый запуск: всё уже назначенное считается известным.
  g.ctx.sendReminders();
  assert.equal(g.fetched.length, 0);
  assert.ok(sheets['Журнал назначений'].length > 2);

  const h = sheets['События'][0];
  const row = (o) => h.map((k) => o[k] ?? '');
  sheets['События'].push(row({ ID: 'N1', 'Тип': 'Гонка', 'Название': 'Новая гонка', 'Дата': '20.11.2026', 'Начало': '12:00', 'Менеджер': 'ivan_petrov', 'Пилоты': 'ivan_petrov' }));
  g.ctx.onEdit({});
  g.ctx.sendReminders();
  g.ctx.sendReminders();
  assert.equal(g.fetched.length, 1);
  assert.equal(g.fetched[0].body.chat_id, '42');
  assert.match(g.fetched[0].body.text, /Роль: <b>пилот и менеджер<\/b>/);
  assert.match(g.fetched[0].body.text, /Новая гонка/);
  assert.equal(g.fetched[0].body.reply_markup.inline_keyboard[0][0].web_app.url, 'https://aliantpt.github.io/melvn-mini-app/');

  // Сняли с гонки и назначили снова — новое сообщение.
  const n1 = sheets['События'].find((r) => r[h.indexOf('ID')] === 'N1');
  n1[h.indexOf('Пилоты')] = '';
  n1[h.indexOf('Менеджер')] = '';
  g.ctx.onEdit({});
  g.ctx.sendReminders();
  n1[h.indexOf('Пилоты')] = 'ivan_petrov';
  g.ctx.onEdit({});
  g.ctx.sendReminders();
  assert.equal(g.fetched.length, 2);
  assert.match(g.fetched[1].body.text, /Роль: <b>пилот<\/b>/);
});
