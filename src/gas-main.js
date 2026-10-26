// Точка входа Google Apps Script. Собирается вместе с logic.js в dist/Code.gs.
// Приложение вызывает: GET <URL веб-приложения>?initData=<Telegram.WebApp.initData>
// Запись дохода менеджером: те же параметры + action=addIncome&raceId=&amount=&note=
// Удаление своей записи: action=deleteIncome&id=
// Запись на тренировку: action=signTraining&trainingId=&laps=; отказ: action=unsignTraining&trainingId=
// Настройки напоминаний: action=saveSettings&racesOn=1&racesLead=1 дн&trainingsOn=0&trainingsLead=02:00
// Напоминания рассылает sendReminders() по таймеру; включается один раз запуском setupReminders().

// Токен бота хранится в свойствах скрипта (Настройки проекта → Свойства скрипта → BOT_TOKEN),
// чтобы при обновлении кода его не нужно было вписывать заново.
function botToken() {
  return PropertiesService.getScriptProperties().getProperty('BOT_TOKEN') || '';
}

const TIMEZONE = 'Europe/Moscow';
const SHEETS = ['Люди', 'События', 'Заработок', 'Тренировки', 'Записи на тренировки', 'Архив событий', 'Архив тренировок', 'Настройки уведомлений'];
const APP_URL = 'https://aliantpt.github.io/melvn-mini-app/';
const SETTINGS_SHEET = 'Настройки уведомлений';
const SETTINGS_HEADERS = ['Telegram ID', 'Пользователь', 'Гонки', 'Гонки за', 'Тренировки', 'Тренировки за', 'Обновлено'];
const SETTINGS_HINTS = ['Заполняется из приложения', 'Ник или ID', 'Да / Нет', 'N дн или чч:мм', 'Да / Нет', 'N дн или чч:мм', ''];
const LOG_SHEET = 'Журнал уведомлений';
const MAX_SENDS_PER_RUN = 50;
const INCOME_SHEET = 'Заработок';
const INCOME_HEADERS = ['ID', 'Дата записи', 'Менеджер', 'ID гонки', 'Сумма', 'Комментарий'];
const INCOME_HINTS = ['Заполняется из приложения', 'Не редактировать вручную без нужды', 'Ник или ID', 'ID из «Событий»', 'Рубли', ''];
const TRAININGS_SHEET = 'Тренировки';
const TRAININGS_HEADERS = ['ID', 'Тип', 'Название', 'Дата', 'Начало', 'Окончание', 'Трасса', 'Адрес', 'Стоимость заезда', 'Мин. заездов', 'Макс. заездов', 'Описание', 'Статус'];
const TRAININGS_HINTS = ['TR1, TR2…', 'Школа / Тренировочные заезды', 'Если пусто — по типу', 'ДД.ММ.ГГГГ', 'ЧЧ:ММ', 'ЧЧ:ММ', 'Для фильтра в приложении', '', 'Рубли за один заезд', 'Пусто — 1', 'Пусто — 10', '', 'Отменено — убрать из расходов'];
const SIGNUP_SHEET = 'Записи на тренировки';
const SIGNUP_HEADERS = ['ID', 'Дата записи', 'Пилот', 'ID тренировки', 'Заездов'];
const SIGNUP_HINTS = ['Заполняется из приложения', 'Не редактировать вручную без нужды', 'Ник или ID', 'ID из «Тренировок»', 'Число'];
// Подпись Telegram действует сутки: перехваченную ссылку нельзя использовать долго.
const MAX_AUTH_AGE_SECONDS = 24 * 3600;
const MAX_INCOME = 10000000;
const MAX_WRITES_PER_HOUR = 30;

function doGet(e) {
  const initData = (e && e.parameter && e.parameter.initData) || '';
  // Без подписи Telegram это не приложение, а браузер: показываем админ-панель (только владельцу).
  if (!initData && e && e.parameter && e.parameter.admin !== undefined) return adminPage_();
  const user = verifyInitData(initData, botToken());
  if (!user) return jsonOut({ error: 'not_telegram' });
  try {
    // Лист «Тренировки» появляется сам при первом открытии приложения после обновления скрипта.
    ensureSheet(TRAININGS_SHEET, TRAININGS_HEADERS, TRAININGS_HINTS);
    try {
      archiveOld();
    } catch (err) {
      // Уборка не должна мешать открыть приложение.
      console.error(err);
    }
    const action = e.parameter.action || '';
    if (action === 'addIncome' || action === 'deleteIncome') {
      const result = changeIncome(action, e.parameter, user);
      if (result) return jsonOut(result);
    }
    if (action === 'saveSettings') {
      const result = saveSettings(e.parameter, user);
      if (result) return jsonOut(result);
    }
    if (action === 'signTraining' || action === 'unsignTraining') {
      const result = changeSignup(action, e.parameter, user);
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
    const sh = ensureSheet(INCOME_SHEET, INCOME_HEADERS, INCOME_HINTS);

    if (action === 'addIncome') {
      const raceId = String(p.raceId || '').trim();
      const amount = /^\s*-/.test(String(p.amount || '')) ? 0 : parseMoney(p.amount);
      if (!(amount > 0 && amount <= MAX_INCOME)) return { error: 'bad_amount' };
      if (!canAddIncome(eventsWithArchive(data), person, raceId)) return { error: 'not_manager' };
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

// Запись на тренировку или отказ. Пилот меняет только свои записи.
// Возвращает объект с ошибкой или null при успехе.
function changeSignup(action, p, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = readSheets();
    const person = findPerson(buildPeople(data['Люди']), user);
    if (!person || !person.active) return { error: 'no_access' };
    const trainingId = String(p.trainingId || '').trim();
    if (action === 'signTraining') {
      const err = canSignTraining(trainingsWithArchive(data), trainingId, String(p.laps || ''));
      if (err) return { error: err };
    }
    if (!allowWrite(person.key)) return { error: 'too_many' };
    const sh = ensureSheet(SIGNUP_SHEET, SIGNUP_HEADERS, SIGNUP_HINTS);

    // Прежняя запись на эту тренировку удаляется, новая добавляется в конец.
    const values = sh.getDataRange().getDisplayValues();
    for (let i = values.length - 1; i >= 2; i--) {
      if (String(values[i][3]).trim() === trainingId && person.keys.includes(normHandle(values[i][2]))) sh.deleteRow(i + 1);
    }
    if (action === 'signTraining') {
      sh.appendRow([Utilities.getUuid(), new Date().toISOString(), safeCell(person.key), safeCell(trainingId), Number(p.laps)]);
    }
    return null;
  } finally {
    lock.releaseLock();
  }
}

// Настройки напоминаний человека: одна строка на человека, новая заменяет старую.
function saveSettings(p, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = readSheets();
    const person = findPerson(buildPeople(data['Люди']), user);
    if (!person || !person.active) return { error: 'no_access' };
    const racesLead = parseLead(p.racesLead);
    const trainingsLead = parseLead(p.trainingsLead);
    if (!racesLead || !trainingsLead) return { error: 'bad_lead' };
    if (!allowWrite(person.key)) return { error: 'too_many' };
    const sh = ensureSheet(SETTINGS_SHEET, SETTINGS_HEADERS, SETTINGS_HINTS);
    const values = sh.getDataRange().getDisplayValues();
    for (let i = values.length - 1; i >= 2; i--) {
      if (person.keys.includes(normHandle(values[i][1]))) sh.deleteRow(i + 1);
    }
    // Апостроф — чтобы таблица не превратила «01:30» во время, а ID в число.
    sh.appendRow([
      "'" + String(Number(user.id) || ''),
      safeCell(person.key),
      p.racesOn === '1' ? 'Да' : 'Нет',
      "'" + racesLead.text,
      p.trainingsOn === '1' ? 'Да' : 'Нет',
      "'" + trainingsLead.text,
      new Date().toISOString(),
    ]);
    return null;
  } finally {
    lock.releaseLock();
  }
}

// Запускается таймером каждые 5 минут и отправляет напоминания, которым пора.
function sendReminders() {
  const token = botToken();
  if (!token) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const data = readSheets();
    const log = ensureSheet(LOG_SHEET, ['Ключ', 'Отправлено'], ['Служебный лист: какие напоминания уже отправлены', '']);
    const logged = log.getDataRange().getDisplayValues();
    const sent = new Set(logged.slice(2).map(function (r) { return r[0]; }));
    const due = dueReminders(data, Date.now(), sent).slice(0, MAX_SENDS_PER_RUN);
    for (let i = 0; i < due.length; i++) {
      const r = due[i];
      let code = 0;
      try {
        code = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
          method: 'post',
          contentType: 'application/json',
          muteHttpExceptions: true,
          payload: JSON.stringify({
            chat_id: r.chatId,
            text: r.text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: APP_URL } }]] },
          }),
        }).getResponseCode();
      } catch (err) {
        // Сеть или Telegram не ответили — попробуем на следующем запуске.
        console.error(err);
      }
      // В журнал — только то, что отправлено, или то, что повторять бесполезно:
      // 400 — чат не найден, 403 — человек запретил боту писать.
      if (code === 200 || code === 400 || code === 403) {
        if (code !== 200) console.error('sendMessage ' + code + ' для ' + r.key + ', больше не пробуем');
        log.appendRow([safeCell(r.key), new Date().toISOString()]);
      } else {
        // 429 (слишком часто), 5xx и обрывы связи: не записываем — через 5 минут отправим снова,
        // пока событие не началось.
        console.error('sendMessage ' + code + ' для ' + r.key + ', повторим через 5 минут');
        if (code === 429) break;
      }
    }
    // Журнал не растёт бесконечно: старые записи удаляются.
    if (logged.length > 3000) log.deleteRows(3, logged.length - 2000);
  } finally {
    lock.releaseLock();
  }
}

// Запустите один раз в редакторе Apps Script (выбрать функцию → «Выполнить»):
// разрешит боту отправлять сообщения и включит таймер напоминаний.
function setupReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendReminders').timeBased().everyMinutes(5).create();
  ensureSheet(SETTINGS_SHEET, SETTINGS_HEADERS, SETTINGS_HINTS);
  sendReminders();
  console.log('Напоминания включены: проверка каждые 5 минут.');
}

// Раз в день: гонки и тренировки, прошедшие больше недели назад, переезжают
// со своих листов на «Архив событий» и «Архив тренировок».
function archiveOld() {
  const props = PropertiesService.getScriptProperties();
  const day = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  if (props.getProperty('archived_on') === day) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    if (props.getProperty('archived_on') === day) return;
    moveOldRows('События', 'Архив событий', buildEvents, day);
    moveOldRows(TRAININGS_SHEET, 'Архив тренировок', buildTrainings, day);
    props.setProperty('archived_on', day);
  } finally {
    lock.releaseLock();
  }
}

function moveOldRows(from, to, build, day) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(from);
  if (!sh) return;
  // Копируется то, что видно в ячейках: так даты не зависят от формата нового листа.
  const shown = sh.getDataRange().getDisplayValues();
  if (shown.length < 3) return;
  const headers = shown[0].map(function (h) { return String(h).trim(); });
  const idCol = headers.indexOf('ID');
  if (idCol < 0) return;
  const rows = shown.slice(2).map(function (r) {
    const row = {};
    headers.forEach(function (h, i) { if (h) row[h] = String(r[i]).trim(); });
    return row;
  });
  const old = staleIds(build(rows), day, ARCHIVE_AFTER_DAYS);
  if (!old.size) return;

  const moved = [];
  for (let i = 2; i < shown.length; i++) {
    if (old.has(String(shown[i][idCol]).trim())) moved.push(i);
  }
  // Сначала копия в архив (колонки сопоставляются по названию), потом удаление.
  const arch = ensureSheet(to, headers, shown[1]);
  const archHeaders = arch.getDataRange().getDisplayValues()[0].map(function (h) { return String(h).trim(); });
  moved.forEach(function (i) {
    arch.appendRow(archHeaders.map(function (h) {
      const j = h ? headers.indexOf(h) : -1;
      return j < 0 ? '' : safeCell(shown[i][j]);
    }));
  });
  // Google не даёт удалить все незакреплённые строки — оставим одну пустую.
  if (sh.getMaxRows() - moved.length <= sh.getFrozenRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);
  for (let k = moved.length - 1; k >= 0; k--) sh.deleteRow(moved[k] + 1);
}

// Служебные листы создаются сами: строка 1 — заголовки, строка 2 — подсказки.
// Если лист уже есть, недостающие колонки дописываются справа.
function ensureSheet(name, headers, hints) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.appendRow(hints);
    sh.setFrozenRows(2);
    return sh;
  }
  const have = (sh.getDataRange().getDisplayValues()[0] || []).map(function (h) { return String(h).trim(); });
  let col = have.length;
  headers.forEach(function (h, i) {
    if (!h || have.indexOf(h) >= 0) return;
    col++;
    sh.getRange(1, col).setValue(h);
    sh.getRange(2, col).setValue(hints[i]);
  });
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
