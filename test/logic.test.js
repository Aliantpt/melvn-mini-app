import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac } from 'node:crypto';
import { buildView, googleCalendarUrl, buildEvents, parseDate } from '../src/logic.js';

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
    { ID: 'R1', 'Тип': 'Гонка', 'Формат': 'Командная', 'Чемпионат': 'Кубок Москвы', 'Этап': '3', 'Название': 'Этап 3', 'Дата': '15.11.2026', 'Начало': '10:00', 'Окончание': '18:00', 'Трасса': 'Картодром', 'Состав': 'M-ELVN Orange', 'Менеджер': 'oleg_manager', 'Пилоты': 'ivan_petrov, 555' },
    { ID: 'R1', 'Состав': 'M-ELVN Carbon', 'Менеджер': 'melvn_boss', 'Пилоты': 'kirill' },
    { ID: 'R3', 'Тип': 'Гонка', 'Формат': 'Командная', 'Название': 'Только второй состав', 'Дата': '06.12.2026', 'Состав': 'A', 'Пилоты': 'someone' },
    { ID: 'R3', 'Состав': 'B', 'Менеджер': 'oleg_manager', 'Пилоты': 'kirill' },
    { ID: 'R2', 'Тип': 'Гонка', 'Формат': 'Личная', 'Чемпионат': 'RMC', 'Этап': 'Финал', 'Название': '', 'Дата': '22.11.2026', 'Начало': '11:00', 'Менеджер': '', 'Пилоты': 'max_kart; oleg_manager' },
    { ID: 'T1', 'Тип': 'Тренировка', 'Название': 'Тренировка', 'Дата': '08.11.2026', 'Статус': 'Отменено', 'Пилоты': 'anna_smirnova, 123456' },
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
  assert.equal(r1.stage, '3');
  const r2 = v.events.find((e) => e.id === 'R2');
  assert.equal(r2.title, 'RMC, Финал');
  assert.match(decodeURIComponent(r1.calendarUrl), /Чемпионат: Кубок Москвы, 3/);
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

// Запуск собранного dist/Code.gs в песочнице с заглушками сервисов Google.
function loadGas(botToken, sheets) {
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
        getSheetByName: (name) => (sheets[name] ? { getDataRange: () => ({ getDisplayValues: () => sheets[name] }) } : null),
      }),
    },
  };
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
