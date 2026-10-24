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
