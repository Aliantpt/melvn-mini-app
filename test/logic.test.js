import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildView, googleCalendarUrl, buildEvents, parseDate } from '../src/logic.js';
import { verifyInitData } from '../src/telegram.js';

const data = {
  'Люди': [
    { Telegram: 'ivan_petrov', 'Имя': 'Иван Петров', 'Пилот': 'Да', 'Менеджер': 'Нет', 'Руководство': 'Нет', 'Активен': 'Да' },
    { Telegram: '@Anna_Smirnova', 'Имя': 'Анна', 'Пилот': 'Да', 'Менеджер': 'Нет', 'Руководство': 'Нет', 'Активен': 'Да' },
    { Telegram: 'max_kart', 'Имя': 'Максим', 'Пилот': 'Да', 'Менеджер': 'Нет', 'Руководство': 'Нет', 'Активен': 'Нет' },
    { Telegram: 'oleg_manager', 'Имя': 'Олег', 'Пилот': 'Да', 'Менеджер': 'Да', 'Руководство': 'Нет', 'Активен': 'Да' },
    { Telegram: 'melvn_boss', 'Имя': 'Босс', 'Пилот': 'Нет', 'Менеджер': 'Нет', 'Руководство': 'Да', 'Активен': 'Да' },
    { Telegram: '123456', 'Имя': 'Без ника', 'Пилот': 'Да', 'Активен': '' },
  ],
  'События': [
    { ID: 'R1', 'Тип': 'Гонка', 'Название': 'Этап 3', 'Дата': '15.11.2026', 'Начало': '10:00', 'Окончание': '18:00', 'Трасса': 'Картодром', 'Статус': 'Запланировано' },
    { ID: 'T1', 'Тип': 'Тренировка', 'Название': 'Тренировка', 'Дата': '08.11.2026', 'Начало': '', 'Статус': 'Отменено' },
    { ID: 'T2', 'Тип': 'Тренировка', 'Название': 'Пилот-менеджер едет', 'Дата': '2026-11-20', 'Начало': '12:00' },
    { ID: 'BAD', 'Тип': 'Гонка', 'Название': 'Без даты', 'Дата': '' },
  ],
  'Составы': [
    { 'ID события': 'R1', 'Экипаж': '#11', 'Номер карта': '11', 'Менеджер': 'oleg_manager', 'Пилоты': 'ivan_petrov, @anna_smirnova' },
    { 'ID события': 'R1', 'Экипаж': '#12', 'Менеджер': 'oleg_manager', 'Пилоты': 'max_kart' },
    { 'ID события': 'T1', 'Экипаж': 'Трен', 'Менеджер': '', 'Пилоты': 'anna_smirnova; 123456' },
    { 'ID события': 'T2', 'Экипаж': 'Трен', 'Менеджер': 'melvn_boss', 'Пилоты': 'oleg_manager' },
  ],
};

const ids = (v) => v.events.map((e) => e.id).sort();

test('pilot sees only own events but all crews there', () => {
  const v = buildView(data, { id: 1, username: 'Ivan_Petrov' }, 'Europe/Moscow');
  assert.equal(v.access, true);
  assert.deepEqual(ids(v), ['R1']);
  assert.equal(v.events[0].crews.length, 2);
  assert.equal(v.events[0].crews[0].mine, true);
  assert.equal(v.events[0].crews[1].mine, false);
});

test('pilot + manager sees union of both roles', () => {
  const v = buildView(data, { id: 2, username: 'oleg_manager' });
  assert.deepEqual(ids(v), ['R1', 'T2']);
});

test('leadership sees everything with a valid date', () => {
  const v = buildView(data, { id: 3, username: 'melvn_boss' });
  assert.deepEqual(ids(v), ['R1', 'T1', 'T2']);
});

test('inactive or unknown person has no access', () => {
  assert.equal(buildView(data, { id: 4, username: 'max_kart' }).access, false);
  const v = buildView(data, { id: 5, username: 'stranger' });
  assert.equal(v.access, false);
  assert.equal(v.username, 'stranger');
});

test('person can be matched by numeric Telegram ID', () => {
  const v = buildView(data, { id: 123456 });
  assert.equal(v.access, true);
  assert.deepEqual(ids(v), ['T1']);
  assert.equal(v.events[0].cancelled, true);
});

test('events are sorted by date', () => {
  const v = buildView(data, { username: 'melvn_boss' });
  assert.deepEqual(v.events.map((e) => e.id), ['T1', 'R1', 'T2']);
});

test('calendar link: timed and all-day', () => {
  const [r1, t1] = buildEvents(data['События'], data['Составы']);
  const u = new URL(googleCalendarUrl(r1, 'Europe/Moscow'));
  assert.equal(u.searchParams.get('dates'), '20261115T100000/20261115T180000');
  assert.equal(u.searchParams.get('ctz'), 'Europe/Moscow');
  assert.match(u.searchParams.get('details'), /#11/);
  const a = new URL(googleCalendarUrl(t1, 'Europe/Moscow'));
  assert.equal(a.searchParams.get('dates'), '20261108/20261109');
  assert.equal(a.searchParams.get('ctz'), null);
});

test('calendar all-day across month end', () => {
  const [e] = buildEvents([{ ID: 'X', 'Дата': '31.12.2026' }], []);
  assert.equal(new URL(googleCalendarUrl(e)).searchParams.get('dates'), '20261231/20270101');
});

test('parseDate formats', () => {
  assert.deepEqual(parseDate('5.1.2027'), { y: 2027, m: 1, d: 5 });
  assert.equal(parseDate('завтра'), null);
});

test('initData signature is verified', async () => {
  const { createHmac } = await import('node:crypto');
  const botToken = '123:ABC';
  const user = JSON.stringify({ id: 42, username: 'ivan_petrov' });
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'q', user });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  const good = await verifyInitData(params.toString(), botToken);
  assert.equal(good.username, 'ivan_petrov');
  assert.equal(await verifyInitData(params.toString(), '123:WRONG'), null);
  params.set('user', JSON.stringify({ id: 1, username: 'hacker' }));
  assert.equal(await verifyInitData(params.toString(), botToken), null);
});
