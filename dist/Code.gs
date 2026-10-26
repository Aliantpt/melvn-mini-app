// M-ELVN Mini App — код для Google Apps Script (Расширения → Apps Script).
// Файл собран автоматически из src/logic.js, src/gas-main.js, src/gas-admin.js и admin/admin.html, правьте исходники.
// Токен бота задаётся один раз: Настройки проекта → Свойства скрипта → BOT_TOKEN.

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

// Админ-панель: страница и серверные функции для неё.
// Панель открывается по адресу отдельного развертывания с доступом «Только я»,
// поэтому Google сам пускает туда только владельца таблицы. Дополнительно каждая
// функция проверяет, что её вызывает именно владелец.

const ADMIN_SHEETS = [
  'Люди', 'События', 'Чемпионаты', 'Тренировки', 'Записи на тренировки', 'Заработок',
  'Архив событий', 'Архив тренировок',
];
// Листы, которые можно менять из панели. Архивы только для просмотра.
const ADMIN_WRITABLE = ['Люди', 'События', 'Чемпионаты', 'Тренировки', 'Записи на тренировки', 'Заработок'];

// Владелец — тот, от чьего имени работает скрипт. У анонимных посетителей
// публичного адреса Google не раскрывает почту, и проверка не проходит.
function isOwner_() {
  const me = Session.getActiveUser().getEmail();
  return !!me && me === Session.getEffectiveUser().getEmail();
}

function adminPage_() {
  if (!isOwner_()) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">Нет доступа.</p>').setTitle('M-ELVN');
  }
  return HtmlService.createHtmlOutput(ADMIN_HTML)
    .setTitle('M-ELVN — админ-панель')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Все листы панели: заголовки и строки (как видны в таблице), с 3-й строки.
function admin_load() {
  if (!isOwner_()) throw new Error('Нет доступа');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = { sheets: {}, me: Session.getActiveUser().getEmail(), url: ss.getUrl() };
  ADMIN_SHEETS.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) { out.sheets[name] = { headers: [], rows: [] }; return; }
    const values = sh.getDataRange().getDisplayValues();
    out.sheets[name] = {
      headers: (values[0] || []).map(function (h) { return String(h).trim(); }),
      rows: values.slice(2).filter(function (r) {
        return r.some(function (c) { return String(c).trim() !== ''; });
      }),
    };
  });
  return out;
}

// Заменяет строки листа: oldRows — строки как их видела панель (для новой записи пусто),
// newRows — объекты «колонка → значение» (для удаления пусто). Если строки в таблице
// успели поменять, ничего не трогаем и просим обновить.
function admin_replace(sheetName, oldRows, newRows) {
  if (!isOwner_()) throw new Error('Нет доступа');
  if (ADMIN_WRITABLE.indexOf(sheetName) < 0) throw new Error('Этот лист из панели не меняется');
  oldRows = oldRows || [];
  newRows = newRows || [];
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName) ||
      ensureSheet(sheetName, adminHeaders_(newRows), adminHeaders_(newRows).map(function () { return ''; }));
    let values = sh.getDataRange().getDisplayValues();
    let headers = (values[0] || []).map(function (h) { return String(h).trim(); });

    // Недостающие колонки дописываются справа.
    adminHeaders_(newRows).forEach(function (h) {
      if (headers.indexOf(h) >= 0) return;
      headers.push(h);
      sh.getRange(1, headers.length).setValue(h);
    });

    // Находим старые строки: каждая должна совпасть ровно с одной строкой таблицы.
    const used = {};
    const positions = oldRows.map(function (old) {
      for (let i = 2; i < values.length; i++) {
        if (!used[i] && sameRow_(values[i], old)) { used[i] = true; return i + 1; }
      }
      return 0;
    });
    if (positions.indexOf(0) >= 0) return { error: 'conflict' };

    const width = headers.length;
    const toArray = function (obj) {
      return headers.map(function (h) {
        const v = obj[h];
        return v === undefined || v === null ? '' : safeCell(String(v));
      });
    };
    // Сначала переписываем строки на их местах, лишние новые — в конец, лишние старые — удаляем.
    const n = Math.min(positions.length, newRows.length);
    for (let k = 0; k < n; k++) sh.getRange(positions[k], 1, 1, width).setValues([toArray(newRows[k])]);
    for (let k = n; k < newRows.length; k++) sh.appendRow(toArray(newRows[k]));
    const extra = positions.slice(n).sort(function (a, b) { return b - a; });
    if (extra.length && sh.getMaxRows() - extra.length <= sh.getFrozenRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);
    extra.forEach(function (r) { sh.deleteRow(r); });
  } finally {
    lock.releaseLock();
  }
  return admin_load();
}

function adminHeaders_(rows) {
  const seen = [];
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) { if (k && seen.indexOf(k) < 0) seen.push(k); });
  });
  return seen;
}

function sameRow_(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (String(a[i] === undefined ? '' : a[i]) !== String(b[i] === undefined ? '' : b[i])) return false;
  }
  return true;
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

// Простое сравнение строк: у localeCompare в Apps Script порядок может отличаться.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// По дате и времени начала, от ранних к поздним.
const byWhen = (a, b) => cmp(a.date + ' ' + (a.start || ''), b.date + ' ' + (b.start || ''));

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
    .sort((a, b) => cmp(b.date, a.date));
}

function canAddIncome(events, person, raceId) {
  const e = events.find((x) => x.id === raceId);
  return !!e && e.crews.some((c) => listsPerson(c.managers, person));
}

// ---- Открытые тренировки (лист «Тренировки») ----
// Админ не вписывает пилотов: каждый сам отмечает «Поеду» и число заездов.
const DEFAULT_MAX_LAPS = 10;
const MAX_LAPS_LIMIT = 30;

function buildTrainings(rows) {
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
function buildSignups(rows) {
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
function canSignTraining(trainings, trainingId, laps) {
  const t = trainings.find((x) => x.id === trainingId);
  if (!t || t.cancelled) return 'no_training';
  if (!/^\d+$/.test(String(laps).trim()) || +laps < t.minLaps || +laps > t.maxLaps) return 'bad_laps';
  return '';
}

const lapsWord = (n) =>
  n % 10 === 1 && n % 100 !== 11 ? 'заезд' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'заезда' : 'заездов';

// Траты на тренировки: стоимость заезда × число заездов.
function buildTrainingSpent(trainings, signups, person) {
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
const ARCHIVE_AFTER_DAYS = 7;

function withArchive(main, archived) {
  const ids = new Set(main.map((e) => e.id));
  return [...main, ...archived.filter((e) => !ids.has(e.id))];
}

function eventsWithArchive(data) {
  return withArchive(buildEvents(data['События']), buildEvents(data['Архив событий']));
}

function trainingsWithArchive(data) {
  return withArchive(buildTrainings(data['Тренировки']), buildTrainings(data['Архив тренировок']));
}

// ID событий, прошедших больше `days` дней назад (todayIso — «ГГГГ-ММ-ДД»).
function staleIds(items, todayIso, days) {
  const [y, m, d] = todayIso.split('-').map(Number);
  const c = new Date(Date.UTC(y, m - 1, d - days));
  const cutoff = isoDate({ y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() });
  return new Set(items.filter((e) => isoDate(e.date) < cutoff).map((e) => e.id));
}

// ---- Напоминания ----
// Настройки человека хранятся на листе «Настройки уведомлений», по строке на человека.
// «За сколько»: «2 дн» (за N дней) или «01:30» (за чч:мм до начала).
const DEFAULT_LEAD = { races: '1 дн', trainings: '02:00' };

function parseLead(v) {
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

function findSettings(rows, person) {
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
function startMs(date, start) {
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
function dueReminders(data, nowMs, sent) {
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

// Сборка ответа для экрана приложения.
function buildView(data, tgUser, timezone) {
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
    me: { name: person.name, roles: person.roles },
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

// Страница админ-панели (из admin/admin.html).
const ADMIN_HTML = "<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>M-ELVN — админ-панель</title>\n<style>\n  :root {\n    --orange: #ff5a00; --carbon: #101011; --white: #ffffff;\n    --bg: #1b1b1d; --bg3: #232326; --line: #2a2a2d; --hint: #9a9aa0; --danger: #ff4d4f;\n    color-scheme: dark;\n  }\n  * { box-sizing: border-box; }\n  body { margin: 0; background: var(--carbon); color: var(--white); font: 14px/1.45 -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }\n  button, input, select, textarea { font: inherit; color: inherit; }\n  .top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 12px 20px; background: var(--bg); border-bottom: 1px solid var(--line); }\n  .brand { font-weight: 800; letter-spacing: .04em; }\n  .brand::before { content: \"\"; display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--orange); margin-right: 8px; vertical-align: middle; }\n  .brand small { font-weight: 600; letter-spacing: 0; color: var(--hint); margin-left: 6px; }\n  .spacer { flex: 1; }\n  .me { color: var(--hint); font-size: 12px; }\n  .layout { display: flex; min-height: calc(100vh - 57px); }\n  nav { width: 200px; flex: none; padding: 14px 10px; border-right: 1px solid var(--line); }\n  nav button { display: flex; justify-content: space-between; width: 100%; text-align: left; border: 0; background: none; padding: 9px 12px; border-radius: 9px; color: var(--hint); font-weight: 600; cursor: pointer; }\n  nav button:hover { background: var(--bg); color: var(--white); }\n  nav button.on { background: var(--white); color: var(--carbon); }\n  nav .cnt { font-weight: 500; opacity: .7; }\n  main { flex: 1; min-width: 0; padding: 18px 22px 60px; max-width: 1100px; }\n  h1 { font-size: 22px; margin: 0 0 14px; }\n  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }\n  .input, select.input, textarea.input { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 8px 11px; min-width: 0; }\n  .input:focus { outline: none; border-color: var(--orange); }\n  textarea.input { width: 100%; min-height: 90px; resize: vertical; }\n  .search { flex: 1; min-width: 180px; }\n  .btn { border: 0; border-radius: 10px; padding: 9px 14px; background: var(--orange); color: var(--white); font-weight: 600; cursor: pointer; white-space: nowrap; }\n  .btn:disabled { opacity: .5; cursor: default; }\n  .btn.ghost { background: var(--line); }\n  .btn.danger { background: transparent; color: var(--danger); box-shadow: inset 0 0 0 1px var(--danger); }\n  .btn.small { padding: 5px 10px; font-size: 13px; }\n  .seg { display: inline-flex; background: var(--bg); border-radius: 10px; padding: 3px; }\n  .seg button { border: 0; background: none; padding: 6px 12px; border-radius: 8px; color: var(--hint); font-weight: 600; cursor: pointer; }\n  .seg button.on { background: var(--white); color: var(--carbon); }\n  .list { display: flex; flex-direction: column; gap: 8px; }\n  .item { display: flex; gap: 14px; align-items: center; width: 100%; text-align: left; border: 0; background: var(--bg); border-radius: 12px; padding: 11px 14px; cursor: pointer; }\n  .item:hover { background: var(--bg3); }\n  .item .main { flex: 1; min-width: 0; }\n  .item .title { font-weight: 600; }\n  .item .meta { color: var(--hint); font-size: 13px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; }\n  .item .side { color: var(--hint); font-size: 13px; text-align: right; white-space: nowrap; }\n  .item.static { cursor: default; }\n  .item.static:hover { background: var(--bg); }\n  .champ { color: var(--orange); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }\n  .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }\n  .badge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: 6px; background: var(--line); color: var(--hint); white-space: nowrap; }\n  .badge.race { background: var(--orange); color: var(--white); }\n  .badge.off { background: #777; color: #fff; }\n  .badge.warn { background: transparent; color: var(--orange); box-shadow: inset 0 0 0 1px var(--orange); }\n  .empty { color: var(--hint); padding: 30px 0; text-align: center; }\n  .cancelled .title { text-decoration: line-through; }\n  /* Редактор */\n  .shade { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 20; display: flex; justify-content: flex-end; }\n  .drawer { width: min(640px, 100%); height: 100%; overflow-y: auto; background: var(--carbon); border-left: 1px solid var(--line); padding: 20px 22px 30px; }\n  .drawer h2 { margin: 0 0 16px; font-size: 20px; display: flex; align-items: center; gap: 10px; }\n  .drawer h2 .x { margin-left: auto; }\n  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; }\n  .grid .wide { grid-column: 1 / -1; }\n  .field label { display: block; font-size: 12px; color: var(--hint); margin-bottom: 4px; font-weight: 600; }\n  .field .input { width: 100%; }\n  .req::after { content: \" *\"; color: var(--orange); }\n  .box { background: var(--bg); border-radius: 12px; padding: 12px 14px; margin-top: 14px; }\n  .box h3 { margin: 0 0 10px; font-size: 12px; color: var(--hint); text-transform: uppercase; letter-spacing: .04em; display: flex; align-items: center; gap: 8px; }\n  .box h3 .btn { margin-left: auto; }\n  .crew { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-top: 10px; }\n  .crew-head { display: flex; gap: 8px; align-items: center; }\n  .crew-head .input { flex: 1; }\n  .who { margin-top: 10px; }\n  .who > span { display: block; font-size: 12px; color: var(--hint); margin-bottom: 4px; font-weight: 600; }\n  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }\n  .chip { display: inline-flex; align-items: center; gap: 4px; background: var(--bg3); border-radius: 999px; padding: 4px 6px 4px 11px; font-size: 13px; }\n  .chip.unknown { box-shadow: inset 0 0 0 1px var(--orange); }\n  .chip button { border: 0; background: none; color: var(--hint); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; }\n  .chips select { background: var(--carbon); border: 1px dashed var(--line); border-radius: 999px; padding: 4px 10px; color: var(--hint); font-size: 13px; max-width: 220px; }\n  .checks { display: flex; flex-wrap: wrap; gap: 14px; }\n  .check { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }\n  .check input { width: 17px; height: 17px; accent-color: var(--orange); }\n  .actions { display: flex; gap: 8px; margin-top: 20px; position: sticky; bottom: -30px; padding: 12px 0; background: var(--carbon); }\n  .actions .spacer { flex: 1; }\n  .err { color: var(--orange); font-size: 13px; margin-top: 10px; min-height: 1em; }\n  .row-line { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--line); }\n  .row-line:first-of-type { border-top: 0; }\n  .row-line .grow { flex: 1; min-width: 0; }\n  .hint { color: var(--hint); font-size: 12px; }\n  .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: var(--white); color: var(--carbon); padding: 10px 16px; border-radius: 10px; font-weight: 600; z-index: 40; box-shadow: 0 6px 24px rgba(0,0,0,.4); max-width: calc(100% - 32px); }\n  .toast.bad { background: var(--orange); color: var(--white); }\n  .loading { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--hint); }\n  .modal { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; padding: 16px; }\n  .modal > div { background: var(--bg); border-radius: 14px; padding: 18px; max-width: 380px; width: 100%; }\n  .modal p { margin: 0 0 16px; }\n  .modal .actions { position: static; margin: 0; padding: 0; background: none; justify-content: flex-end; }\n  @media (max-width: 760px) {\n    .layout { flex-direction: column; }\n    nav { width: auto; display: flex; gap: 4px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 8px 12px; }\n    nav button { width: auto; flex: none; gap: 6px; }\n    main { padding: 14px 14px 60px; }\n    .grid { grid-template-columns: 1fr; }\n    .me { display: none; }\n    .top { padding: 12px 14px; }\n    .drawer { padding: 16px 14px 30px; }\n  }\n</style>\n</head>\n<body>\n<header class=\"top\">\n  <div class=\"brand\">M-ELVN<small>админ-панель</small></div>\n  <div class=\"spacer\"></div>\n  <span class=\"me\" id=\"me\"></span>\n  <a class=\"btn ghost small\" id=\"sheet-link\" target=\"_blank\" rel=\"noopener\" style=\"text-decoration:none\" hidden>Таблица</a>\n  <button class=\"btn ghost small\" id=\"reload\">Обновить</button>\n</header>\n<div class=\"layout\">\n  <nav id=\"nav\"></nav>\n  <main id=\"main\"><div class=\"loading\">Загрузка…</div></main>\n</div>\n<div id=\"layer\"></div>\n<script>\n(function () {\n  'use strict';\n  // ---- Связь с таблицей ----\n  function call(fn) {\n    const args = Array.prototype.slice.call(arguments, 1);\n    return new Promise(function (resolve, reject) {\n      google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn].apply(null, args);\n    });\n  }\n\n  const esc = (s) => String(s == null ? '' : s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  const $ = (sel, root) => (root || document).querySelector(sel);\n  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));\n  const yes = (v) => ['да', 'yes', 'true', '1', '+', 'x', 'х'].indexOf(String(v || '').trim().toLowerCase()) >= 0;\n  const norm = (v) => String(v || '').trim().replace(/^@/, '').replace(/^https?:\\/\\/t\\.me\\//i, '').toLowerCase();\n  const split = (v) => String(v || '').split(/[,;\\n]+/).map((x) => x.trim().replace(/^@/, '')).filter(Boolean);\n\n  // Даты: в таблице «ДД.ММ.ГГГГ», в полях формы «ГГГГ-ММ-ДД».\n  function toIso(v) {\n    const s = String(v || '').trim();\n    let m = s.match(/^(\\d{1,2})[./-](\\d{1,2})[./-](\\d{4})$/);\n    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');\n    m = s.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/);\n    return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : '';\n  }\n  const fromIso = (iso) => (iso ? iso.split('-').reverse().join('.') : '');\n  const toTime = (v) => {\n    const m = String(v || '').trim().match(/^(\\d{1,2})[:.](\\d{2})/);\n    return m ? m[1].padStart(2, '0') + ':' + m[2] : '';\n  };\n  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];\n  const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];\n  function fmtDate(iso) {\n    if (!iso) return 'без даты';\n    const p = iso.split('-').map(Number);\n    return p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0] + ', ' + DAYS[new Date(p[0], p[1] - 1, p[2]).getDay()];\n  }\n  const today = () => {\n    const t = new Date();\n    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');\n  };\n  const money = (v) => {\n    const n = Number(String(v || '').replace(/[\\s ]/g, '').replace(/[.,](?=\\d{3}(?:[.,]|$))/g, '').replace(',', '.').match(/\\d+(?:\\.\\d+)?/));\n    return isFinite(n) && n ? Math.round(n).toLocaleString('ru-RU') + ' ₽' : String(v || '');\n  };\n\n  // ---- Данные ----\n  let data = null;\n  let section = 'events';\n  const ui = { q: '', when: 'upcoming', champ: '' };\n\n  function sheet(name) {\n    return (data && data.sheets[name]) || { headers: [], rows: [] };\n  }\n  function objects(name) {\n    const s = sheet(name);\n    return s.rows.map((r) => {\n      const o = {};\n      s.headers.forEach((h, i) => { if (h) o[h] = r[i] == null ? '' : String(r[i]); });\n      return { obj: o, raw: r };\n    });\n  }\n\n  function people() {\n    return objects('Люди').map((x) => {\n      const o = x.obj;\n      const key = norm(o['Telegram']) || norm(o['Telegram ID']);\n      return {\n        raw: x.raw, obj: o, key, keys: [norm(o['Telegram']), norm(o['Telegram ID'])].filter(Boolean),\n        name: o['Имя'] || (key ? '@' + key : '—'),\n        pilot: yes(o['Пилот']), manager: yes(o['Менеджер']), lead: yes(o['Руководство']),\n        active: String(o['Активен'] || '').trim().toLowerCase() !== 'нет',\n      };\n    });\n  }\n  function nameOf(handle) {\n    const k = norm(handle);\n    const p = people().find((x) => x.keys.indexOf(k) >= 0);\n    return p ? p.name : '@' + handle;\n  }\n\n  // Гонка = все строки с одним ID: первая с датой — основная, каждая строка — состав.\n  function groupEvents(name) {\n    const map = new Map();\n    objects(name).forEach((x) => {\n      const id = String(x.obj['ID'] || '').trim();\n      if (!id) return;\n      if (!map.has(id)) map.set(id, { id, rows: [], base: null, crews: [] });\n      const g = map.get(id);\n      g.rows.push(x);\n      if (!g.base || (!toIso(g.base['Дата']) && toIso(x.obj['Дата']))) g.base = x.obj;\n      const crew = { name: x.obj['Состав'] || '', managers: split(x.obj['Менеджер']), pilots: split(x.obj['Пилоты']) };\n      if (crew.name || crew.managers.length || crew.pilots.length) g.crews.push(crew);\n    });\n    return Array.from(map.values()).map((g) => {\n      const b = g.base;\n      const stage = String(b['Этап'] || '').trim();\n      const stageText = /^\\d+$/.test(stage) ? (/трен/i.test(b['Тип']) ? 'Тренировка ' : 'Этап ') + stage : stage;\n      g.date = toIso(b['Дата']);\n      g.title = b['Название'] || [b['Чемпионат'], stageText].filter(Boolean).join(' — ') || g.id;\n      g.cancelled = String(b['Статус'] || '').trim().toLowerCase().indexOf('отмен') === 0;\n      return g;\n    });\n  }\n\n  function trainings(name) {\n    return objects(name).filter((x) => String(x.obj['ID'] || '').trim()).map((x) => {\n      const o = x.obj;\n      return {\n        raw: x.raw, obj: o, id: String(o['ID']).trim(), date: toIso(o['Дата']),\n        title: o['Название'] || o['Тип'] || 'Тренировка',\n        cancelled: String(o['Статус'] || '').trim().toLowerCase().indexOf('отмен') === 0,\n      };\n    });\n  }\n  function signups() {\n    return objects('Записи на тренировки').map((x) => ({ raw: x.raw, obj: x.obj, training: String(x.obj['ID тренировки'] || '').trim() }));\n  }\n\n  // ---- Сохранение ----\n  async function replace(sheetName, oldRows, newRows, okText) {\n    try {\n      const res = await call('admin_replace', sheetName, oldRows, newRows);\n      if (res && res.error === 'conflict') {\n        toast('Пока вы редактировали, эти строки поменяли в таблице. Данные обновлены — повторите правку.', true);\n        await load();\n        return false;\n      }\n      data = res;\n      closeDrawer();\n      render();\n      toast(okText || 'Сохранено');\n      return true;\n    } catch (e) {\n      toast('Не удалось сохранить: ' + (e && e.message ? e.message : e), true);\n      return false;\n    }\n  }\n\n  async function load() {\n    try {\n      data = await call('admin_load');\n      $('#me').textContent = data.me || '';\n      if (data.url) {\n        $('#sheet-link').href = data.url;\n        $('#sheet-link').hidden = false;\n      }\n      render();\n    } catch (e) {\n      $('#main').innerHTML = '<div class=\"empty\">Не удалось загрузить данные: ' + esc(e && e.message ? e.message : e) + '</div>';\n    }\n  }\n\n  // ---- Общие элементы ----\n  let toastTimer = null;\n  function toast(text, bad) {\n    let t = $('.toast');\n    if (!t) {\n      t = document.createElement('div');\n      document.body.appendChild(t);\n    }\n    t.className = 'toast' + (bad ? ' bad' : '');\n    t.textContent = text;\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(() => t.remove(), bad ? 6000 : 2500);\n  }\n\n  function confirmBox(text, okLabel) {\n    return new Promise((resolve) => {\n      const m = document.createElement('div');\n      m.className = 'modal';\n      m.innerHTML = '<div><p>' + esc(text) + '</p><div class=\"actions\"><button class=\"btn ghost\" data-no>Отмена</button><button class=\"btn\" data-yes>' + esc(okLabel || 'Удалить') + '</button></div></div>';\n      document.body.appendChild(m);\n      const done = (v) => { m.remove(); resolve(v); };\n      $('[data-no]', m).onclick = () => done(false);\n      $('[data-yes]', m).onclick = () => done(true);\n      m.onclick = (e) => { if (e.target === m) done(false); };\n    });\n  }\n\n  function openDrawer(html) {\n    $('#layer').innerHTML = '<div class=\"shade\"><div class=\"drawer\">' + html + '</div></div>';\n    const shade = $('#layer .shade');\n    shade.addEventListener('mousedown', (e) => { if (e.target === shade) closeDrawer(); });\n    $$('[data-close]', shade).forEach((b) => (b.onclick = closeDrawer));\n    return $('.drawer', shade);\n  }\n  function closeDrawer() {\n    $('#layer').innerHTML = '';\n  }\n  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('.modal')) closeDrawer(); });\n\n  const field = (label, html, cls) => '<div class=\"field ' + (cls || '') + '\"><label class=\"' + (/\\*$/.test(label) ? 'req' : '') + '\">' + esc(label.replace(/\\s*\\*$/, '')) + '</label>' + html + '</div>';\n  const input = (name, value, attrs) => '<input class=\"input\" name=\"' + esc(name) + '\" value=\"' + esc(value) + '\" ' + (attrs || '') + '>';\n  const select = (name, value, options, attrs) => {\n    const opts = options.slice();\n    if (value && opts.indexOf(value) < 0) opts.unshift(value);\n    return '<select class=\"input\" name=\"' + esc(name) + '\" ' + (attrs || '') + '>' + opts.map((o) => '<option value=\"' + esc(o) + '\"' + (o === value ? ' selected' : '') + '>' + esc(o || '—') + '</option>').join('') + '</select>';\n  };\n  const formValues = (root) => {\n    const o = {};\n    $$('[name]', root).forEach((el) => { o[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim(); });\n    return o;\n  };\n  const championships = () => objects('Чемпионаты').map((x) => String(x.obj['Чемпионат'] || '').trim()).filter(Boolean);\n  const tracks = () => {\n    const set = new Set();\n    groupEvents('События').forEach((g) => g.base['Трасса'] && set.add(g.base['Трасса']));\n    trainings('Тренировки').forEach((t) => t.obj['Трасса'] && set.add(t.obj['Трасса']));\n    return Array.from(set).sort();\n  };\n  const datalist = (id, items) => '<datalist id=\"' + id + '\">' + items.map((x) => '<option value=\"' + esc(x) + '\">').join('') + '</datalist>';\n\n  // ---- Навигация ----\n  const SECTIONS = [\n    ['events', 'Гонки'], ['trainings', 'Тренировки'], ['people', 'Люди'],\n    ['champs', 'Чемпионаты'], ['income', 'Заработок'], ['archive', 'Архив'],\n  ];\n  function counts() {\n    return {\n      events: groupEvents('События').length,\n      trainings: trainings('Тренировки').length,\n      people: people().length,\n      champs: championships().length,\n      income: objects('Заработок').length,\n      archive: groupEvents('Архив событий').length + trainings('Архив тренировок').length,\n    };\n  }\n  function render() {\n    const c = counts();\n    $('#nav').innerHTML = SECTIONS.map((s) => '<button class=\"' + (s[0] === section ? 'on' : '') + '\" data-sec=\"' + s[0] + '\">' + s[1] + ' <span class=\"cnt\">' + c[s[0]] + '</span></button>').join('');\n    $$('[data-sec]').forEach((b) => (b.onclick = () => { section = b.dataset.sec; ui.q = ''; render(); }));\n    const m = $('#main');\n    m.innerHTML = ({ events: eventsView, trainings: trainingsView, people: peopleView, champs: champsView, income: incomeView, archive: archiveView })[section]();\n    bindToolbar();\n    if (section === 'champs') bindChamps();\n    if (section === 'income') bindIncome();\n  }\n\n  function toolbar(addLabel, extra) {\n    return '<div class=\"bar\"><input class=\"input search\" id=\"q\" placeholder=\"Поиск по названию\" value=\"' + esc(ui.q) + '\">' + (extra || '') + (addLabel ? '<button class=\"btn\" id=\"add\">+ ' + esc(addLabel) + '</button>' : '') + '</div>';\n  }\n  function bindToolbar() {\n    const q = $('#q');\n    if (q) {\n      q.oninput = () => {\n        ui.q = q.value;\n        const pos = q.selectionStart;\n        render();\n        const nq = $('#q');\n        nq.focus();\n        nq.setSelectionRange(pos, pos);\n      };\n    }\n    $$('[data-when]').forEach((b) => (b.onclick = () => { ui.when = b.dataset.when; render(); }));\n    const ch = $('#champ-filter');\n    if (ch) ch.onchange = () => { ui.champ = ch.value; render(); };\n    const add = $('#add');\n    if (add) add.onclick = () => ({ events: () => editEvent(null), trainings: () => editTraining(null), people: () => editPerson(null), champs: addChamp })[section]();\n    $$('[data-event]').forEach((b) => (b.onclick = () => editEvent(b.dataset.event)));\n    $$('[data-training]').forEach((b) => (b.onclick = () => editTraining(b.dataset.training)));\n    $$('[data-person]').forEach((b) => (b.onclick = () => editPerson(Number(b.dataset.person))));\n  }\n  const fold = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е');\n  const match = (text) => !ui.q.trim() || fold(text).indexOf(fold(ui.q.trim())) >= 0;\n  const whenSeg = () => '<div class=\"seg\">' + [['upcoming', 'Предстоящие'], ['past', 'Прошедшие'], ['all', 'Все']].map((w) => '<button class=\"' + (ui.when === w[0] ? 'on' : '') + '\" data-when=\"' + w[0] + '\">' + w[1] + '</button>').join('') + '</div>';\n  function byWhen(list) {\n    const t = today();\n    const key = (x) => (x.date || '9999') + ' ' + toTime((x.base || x.obj)['Начало']);\n    let out = list.filter((x) => ui.when === 'all' || (ui.when === 'upcoming' ? !x.date || x.date >= t : x.date && x.date < t));\n    out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));\n    if (ui.when === 'past') out.reverse();\n    return out;\n  }\n\n  // ---- Гонки ----\n  function eventsView() {\n    const champs = championships();\n    const list = byWhen(groupEvents('События')).filter((g) => (!ui.champ || g.base['Чемпионат'] === ui.champ) &&\n      match([g.id, g.title, g.base['Чемпионат'], g.base['Трасса']].concat(g.crews.map((c) => c.name + ' ' + c.pilots.concat(c.managers).map(nameOf).join(' '))).join(' ')));\n    const champSel = '<select class=\"input\" id=\"champ-filter\"><option value=\"\">Все чемпионаты</option>' + champs.map((c) => '<option' + (c === ui.champ ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>';\n    return '<h1>Гонки и назначенные тренировки</h1>' + toolbar('Гонка', whenSeg() + champSel) +\n      '<div class=\"list\">' + (list.map(eventItem).join('') || '<div class=\"empty\">Ничего не найдено</div>') + '</div>';\n  }\n  function eventItem(g) {\n    const b = g.base;\n    const pilots = g.crews.reduce((n, c) => n + c.pilots.length, 0);\n    const type = b['Тип'] || 'Событие';\n    const champ = b['Чемпионат'] && g.title.indexOf(b['Чемпионат']) !== 0 ? '<div class=\"champ\">' + esc(b['Чемпионат']) + '</div>' : '';\n    return '<button class=\"item ' + (g.cancelled ? 'cancelled' : '') + '\" data-event=\"' + esc(g.id) + '\"><div class=\"main\">' + champ +\n      '<div class=\"title\">' + esc(g.title) + '</div>' +\n      '<div class=\"meta\">' + esc([fmtDate(g.date), toTime(b['Начало']), b['Трасса']].filter(Boolean).join(' · ')) + '</div>' +\n      '<div class=\"badges\">' + (g.cancelled ? '<span class=\"badge off\">Отменено</span>' : '<span class=\"badge ' + (/гонк/i.test(type) ? 'race' : '') + '\">' + esc(type) + '</span>') +\n      (b['Формат'] ? '<span class=\"badge\">' + esc(b['Формат']) + '</span>' : '') + (!g.date ? '<span class=\"badge warn\">Нет даты — в приложении не видна</span>' : '') + '</div></div>' +\n      '<div class=\"side\">' + esc(g.id) + '<br>' + (g.crews.length > 1 ? g.crews.length + ' сост. · ' : '') + pilots + ' пил.</div></button>';\n  }\n\n  // Выбор людей: чипы и выпадающий список «добавить».\n  function picker(role, list) {\n    const ps = people().filter((p) => p.active).sort((a, b) => (b[role] - a[role]) || a.name.localeCompare(b.name, 'ru'));\n    const chips = list.map((h) => {\n      const known = people().some((p) => p.keys.indexOf(norm(h)) >= 0);\n      return '<span class=\"chip ' + (known ? '' : 'unknown') + '\" data-h=\"' + esc(h) + '\" title=\"' + (known ? '' : 'Нет на листе «Люди»') + '\">' + esc(nameOf(h)) + '<button type=\"button\" data-rm aria-label=\"Убрать\">×</button></span>';\n    }).join('');\n    const opts = ps.filter((p) => !list.some((h) => p.keys.indexOf(norm(h)) >= 0))\n      .map((p) => '<option value=\"' + esc(p.obj['Telegram'] || p.obj['Telegram ID']) + '\">' + esc(p.name) + (p[role] ? '' : ' (не ' + (role === 'pilot' ? 'пилот' : 'менеджер') + ')') + '</option>').join('');\n    return '<div class=\"chips\" data-picker=\"' + role + '\">' + chips + '<select data-addp><option value=\"\">+ добавить</option>' + opts + '</select></div>';\n  }\n  function pickerValues(root) {\n    return $$('.chip', root).map((c) => c.dataset.h);\n  }\n\n  function crewHtml(c, i) {\n    return '<div class=\"crew\" data-crew=\"' + i + '\"><div class=\"crew-head\">' +\n      '<input class=\"input\" data-crew-name placeholder=\"Название состава (если составов несколько)\" value=\"' + esc(c.name) + '\">' +\n      '<button type=\"button\" class=\"btn ghost small\" data-crew-del>Убрать состав</button></div>' +\n      '<div class=\"who\"><span>Пилоты</span>' + picker('pilot', c.pilots) + '</div>' +\n      '<div class=\"who\"><span>Менеджер</span>' + picker('manager', c.managers) + '</div></div>';\n  }\n\n  function editEvent(id) {\n    const g = id ? groupEvents('События').find((x) => x.id === id) : null;\n    const b = g ? g.base : { 'Тип': 'Гонка', 'Формат': 'Командная', 'Статус': 'Запланировано' };\n    let crews = g ? g.crews.map((c) => ({ name: c.name, pilots: c.pilots.slice(), managers: c.managers.slice() })) : [{ name: '', pilots: [], managers: [] }];\n    const champs = [''].concat(championships());\n    const d = openDrawer(\n      '<h2>' + (g ? esc(g.title) : 'Новая гонка') + '<button class=\"btn ghost small x\" data-close>Закрыть</button></h2>' +\n      '<form id=\"f\"><div class=\"grid\">' +\n      field('ID *', input('ID', g ? g.id : '', 'required placeholder=\"Например, ROTY272K\"')) +\n      field('Тип', select('Тип', b['Тип'] || '', ['Гонка', 'Тренировка'])) +\n      field('Чемпионат', select('Чемпионат', b['Чемпионат'] || '', champs)) +\n      field('Этап', input('Этап', b['Этап'] || '', 'placeholder=\"3, 2A, Финал\"')) +\n      field('Формат', select('Формат', b['Формат'] || '', ['Командная', 'Личная'])) +\n      field('Статус', select('Статус', b['Статус'] || '', ['Запланировано', 'Отменено'])) +\n      field('Название', input('Название', b['Название'] || '', 'placeholder=\"Если пусто — «Чемпионат — Этап»\"'), 'wide') +\n      field('Дата *', input('Дата', toIso(b['Дата']), 'type=\"date\" required')) +\n      field('Стоимость', input('Стоимость', b['Стоимость'] || '', 'placeholder=\"7500 Руб.\"')) +\n      field('Начало', input('Начало', toTime(b['Начало']), 'type=\"time\"')) +\n      field('Окончание', input('Окончание', toTime(b['Окончание']), 'type=\"time\"')) +\n      field('Трасса', input('Трасса', b['Трасса'] || '', 'list=\"tracks\"') + datalist('tracks', tracks())) +\n      field('Адрес', input('Адрес', b['Адрес'] || '')) +\n      field('Регламент', input('Регламент', b['Регламент'] || '', 'placeholder=\"Ссылка\"'), 'wide') +\n      field('Описание', '<textarea class=\"input\" name=\"Описание\">' + esc(b['Описание'] || '') + '</textarea>', 'wide') +\n      '</div><div class=\"box\"><h3>Составы<button type=\"button\" class=\"btn ghost small\" id=\"add-crew\">+ Состав</button></h3><div id=\"crews\"></div>' +\n      '<div class=\"hint\" style=\"margin-top:8px\">Пилоты и менеджер видят гонку в приложении. Оранжевая рамка — человека нет на листе «Люди».</div></div>' +\n      '<div class=\"err\" id=\"err\"></div>' +\n      '<div class=\"actions\">' + (g ? '<button type=\"button\" class=\"btn danger\" id=\"del\">Удалить гонку</button>' : '') + '<div class=\"spacer\"></div><button type=\"button\" class=\"btn ghost\" data-close>Отмена</button><button class=\"btn\" id=\"save\">Сохранить</button></div></form>');\n    $$('[data-close]', d).forEach((x) => (x.onclick = closeDrawer));\n\n    // Составы держим в массиве и перерисовываем.\n    const sync = () => {\n      crews = $$('[data-crew]', d).map((el) => ({\n        name: $('[data-crew-name]', el).value.trim(),\n        pilots: pickerValues($('[data-picker=\"pilot\"]', el)),\n        managers: pickerValues($('[data-picker=\"manager\"]', el)),\n      }));\n    };\n    const drawCrews = () => {\n      $('#crews', d).innerHTML = crews.map(crewHtml).join('') || '<div class=\"hint\">Составов нет — гонку увидит только руководство.</div>';\n      $$('[data-crew]', d).forEach((el, i) => {\n        $('[data-crew-del]', el).onclick = () => { sync(); crews.splice(i, 1); drawCrews(); };\n        $$('[data-rm]', el).forEach((x) => (x.onclick = () => { x.parentNode.remove(); sync(); drawCrews(); }));\n        $$('[data-addp]', el).forEach((s) => (s.onchange = () => {\n          sync();\n          const role = s.parentNode.dataset.picker === 'pilot' ? 'pilots' : 'managers';\n          if (s.value) crews[i][role].push(s.value);\n          drawCrews();\n        }));\n      });\n    };\n    drawCrews();\n    $('#add-crew', d).onclick = () => { sync(); crews.push({ name: '', pilots: [], managers: [] }); drawCrews(); };\n\n    $('#f', d).onsubmit = async (e) => {\n      e.preventDefault();\n      sync();\n      const v = formValues($('.grid', d));\n      const err = $('#err', d);\n      if (!v['ID']) return (err.textContent = 'Укажите ID.');\n      if (!v['Дата']) return (err.textContent = 'Укажите дату — без неё гонка не появится в приложении.');\n      const taken = groupEvents('События').concat(groupEvents('Архив событий')).some((x) => x.id === v['ID'] && (!g || x.id !== g.id));\n      if (taken) return (err.textContent = 'ID «' + v['ID'] + '» уже занят (в гонках или архиве). Придумайте другой.');\n      const baseObj = Object.assign({}, b, v, { 'Дата': fromIso(v['Дата']) });\n      delete baseObj['Состав'];\n      delete baseObj['Менеджер'];\n      delete baseObj['Пилоты'];\n      const list = crews.filter((c) => c.name || c.pilots.length || c.managers.length);\n      const crewObj = (c) => ({ 'Состав': c.name, 'Менеджер': c.managers.join(', '), 'Пилоты': c.pilots.join(', ') });\n      const rows = [Object.assign({}, baseObj, crewObj(list[0] || { name: '', pilots: [], managers: [] }))]\n        .concat(list.slice(1).map((c) => Object.assign({ 'ID': v['ID'] }, crewObj(c))));\n      $('#save', d).disabled = true;\n      const ok = await replace('События', g ? g.rows.map((x) => x.raw) : [], rows, 'Гонка сохранена');\n      if (!ok && $('#save', d)) $('#save', d).disabled = false;\n    };\n    const del = $('#del', d);\n    if (del) del.onclick = async () => {\n      if (await confirmBox('Удалить гонку «' + g.title + '» со всеми составами? Её траты пропадут из финансов.')) replace('События', g.rows.map((x) => x.raw), [], 'Гонка удалена');\n    };\n  }\n\n  // ---- Тренировки ----\n  function trainingsView() {\n    const sign = signups();\n    const list = byWhen(trainings('Тренировки')).filter((t) => match([t.id, t.title, t.obj['Тип'], t.obj['Трасса']].join(' ')));\n    return '<h1>Открытые тренировки</h1>' + toolbar('Тренировка', whenSeg()) + '<div class=\"list\">' + (list.map((t) => {\n      const going = sign.filter((s) => s.training === t.id);\n      return '<button class=\"item ' + (t.cancelled ? 'cancelled' : '') + '\" data-training=\"' + esc(t.id) + '\"><div class=\"main\"><div class=\"title\">' + esc(t.title) + '</div>' +\n        '<div class=\"meta\">' + esc([fmtDate(t.date), toTime(t.obj['Начало']), t.obj['Трасса'], t.obj['Стоимость заезда'] ? money(t.obj['Стоимость заезда']) + ' за заезд' : ''].filter(Boolean).join(' · ')) + '</div>' +\n        '<div class=\"badges\">' + (t.cancelled ? '<span class=\"badge off\">Отменено</span>' : '') + (t.obj['Тип'] ? '<span class=\"badge\">' + esc(t.obj['Тип']) + '</span>' : '') + '</div></div>' +\n        '<div class=\"side\">' + esc(t.id) + '<br>едут: ' + going.length + '</div></button>';\n    }).join('') || '<div class=\"empty\">Ничего не найдено</div>') + '</div>';\n  }\n\n  function editTraining(id) {\n    const t = id ? trainings('Тренировки').find((x) => x.id === id) : null;\n    const o = t ? t.obj : { 'Тип': 'Тренировочные заезды', 'Статус': 'Запланировано' };\n    const going = t ? signups().filter((s) => s.training === t.id) : [];\n    const d = openDrawer(\n      '<h2>' + (t ? esc(t.title) : 'Новая тренировка') + '<button class=\"btn ghost small x\" data-close>Закрыть</button></h2>' +\n      '<form id=\"f\"><div class=\"grid\">' +\n      field('ID *', input('ID', t ? t.id : '', 'required placeholder=\"Например, TR12\"')) +\n      field('Тип', select('Тип', o['Тип'] || '', ['Школа', 'Тренировочные заезды'])) +\n      field('Название', input('Название', o['Название'] || '', 'placeholder=\"Если пусто — по типу\"'), 'wide') +\n      field('Дата *', input('Дата', toIso(o['Дата']), 'type=\"date\" required')) +\n      field('Статус', select('Статус', o['Статус'] || '', ['Запланировано', 'Отменено'])) +\n      field('Начало', input('Начало', toTime(o['Начало']), 'type=\"time\"')) +\n      field('Окончание', input('Окончание', toTime(o['Окончание']), 'type=\"time\"')) +\n      field('Трасса', input('Трасса', o['Трасса'] || '', 'list=\"tracks\"') + datalist('tracks', tracks())) +\n      field('Адрес', input('Адрес', o['Адрес'] || '')) +\n      field('Стоимость заезда, ₽ *', input('Стоимость заезда', o['Стоимость заезда'] || '', 'required inputmode=\"decimal\"')) +\n      '<div></div>' +\n      field('Мин. заездов', input('Мин. заездов', o['Мин. заездов'] || '', 'type=\"number\" min=\"1\" max=\"30\" placeholder=\"1\"')) +\n      field('Макс. заездов', input('Макс. заездов', o['Макс. заездов'] || '', 'type=\"number\" min=\"1\" max=\"30\" placeholder=\"10\"')) +\n      field('Описание', '<textarea class=\"input\" name=\"Описание\">' + esc(o['Описание'] || '') + '</textarea>', 'wide') +\n      '</div>' +\n      (t ? '<div class=\"box\"><h3>Записались (' + going.length + ')</h3>' + (going.map((s, i) =>\n        '<div class=\"row-line\"><span class=\"grow\">' + esc(nameOf(s.obj['Пилот'])) + ' <span class=\"hint\">· ' + esc(s.obj['Заездов']) + ' заезд.</span></span><button type=\"button\" class=\"btn danger small\" data-unsign=\"' + i + '\">Убрать</button></div>').join('') || '<div class=\"hint\">Пока никто не отметился.</div>') + '</div>' : '') +\n      '<div class=\"err\" id=\"err\"></div>' +\n      '<div class=\"actions\">' + (t ? '<button type=\"button\" class=\"btn danger\" id=\"del\">Удалить</button>' : '') + '<div class=\"spacer\"></div><button type=\"button\" class=\"btn ghost\" data-close>Отмена</button><button class=\"btn\" id=\"save\">Сохранить</button></div></form>');\n    $$('[data-close]', d).forEach((x) => (x.onclick = closeDrawer));\n    $$('[data-unsign]', d).forEach((b) => (b.onclick = async () => {\n      const s = going[Number(b.dataset.unsign)];\n      if (await confirmBox('Убрать ' + nameOf(s.obj['Пилот']) + ' из записавшихся?', 'Убрать')) replace('Записи на тренировки', [s.raw], [], 'Запись убрана');\n    }));\n    $('#f', d).onsubmit = async (e) => {\n      e.preventDefault();\n      const v = formValues($('.grid', d));\n      const err = $('#err', d);\n      if (!v['ID'] || !v['Дата']) return (err.textContent = 'Укажите ID и дату.');\n      const min = Number(v['Мин. заездов'] || 1);\n      const max = Number(v['Макс. заездов'] || 10);\n      if (min > max) return (err.textContent = 'Минимум заездов больше максимума.');\n      const taken = trainings('Тренировки').concat(trainings('Архив тренировок')).some((x) => x.id === v['ID'] && (!t || x.id !== t.id));\n      if (taken) return (err.textContent = 'ID «' + v['ID'] + '» уже занят. Придумайте другой.');\n      $('#save', d).disabled = true;\n      const ok = await replace('Тренировки', t ? [t.raw] : [], [Object.assign({}, o, v, { 'Дата': fromIso(v['Дата']) })], 'Тренировка сохранена');\n      if (!ok && $('#save', d)) $('#save', d).disabled = false;\n    };\n    const del = $('#del', d);\n    if (del) del.onclick = async () => {\n      if (await confirmBox('Удалить тренировку «' + t.title + '»?')) replace('Тренировки', [t.raw], [], 'Тренировка удалена');\n    };\n  }\n\n  // ---- Люди ----\n  function peopleView() {\n    const list = people().map((p, i) => Object.assign(p, { i })).filter((p) => match([p.name, p.obj['Telegram'], p.obj['Telegram ID'], p.obj['Телефон']].join(' ')))\n      .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'ru'));\n    return '<h1>Люди</h1>' + toolbar('Человек') + '<div class=\"list\">' + (list.map((p) =>\n      '<button class=\"item\" data-person=\"' + p.i + '\" style=\"' + (p.active ? '' : 'opacity:.55') + '\"><div class=\"main\"><div class=\"title\">' + esc(p.name) + '</div>' +\n      '<div class=\"meta\">' + esc([p.obj['Telegram'] ? '@' + p.obj['Telegram'] : '', p.obj['Telegram ID'] ? 'ID ' + p.obj['Telegram ID'] : '', p.obj['Телефон']].filter(Boolean).join(' · ')) + '</div>' +\n      '<div class=\"badges\">' + (p.pilot ? '<span class=\"badge race\">Пилот</span>' : '') + (p.manager ? '<span class=\"badge\">Менеджер</span>' : '') + (p.lead ? '<span class=\"badge warn\">Руководство</span>' : '') + (p.active ? '' : '<span class=\"badge off\">Не активен</span>') + '</div></div></button>'\n    ).join('') || '<div class=\"empty\">Ничего не найдено</div>') + '</div>';\n  }\n\n  function editPerson(i) {\n    const p = i == null ? null : people()[i];\n    const o = p ? p.obj : { 'Пилот': 'Да', 'Активен': 'Да' };\n    const d = openDrawer(\n      '<h2>' + (p ? esc(p.name) : 'Новый человек') + '<button class=\"btn ghost small x\" data-close>Закрыть</button></h2>' +\n      '<form id=\"f\"><div class=\"grid\">' +\n      field('Имя *', input('Имя', o['Имя'] || '', 'required placeholder=\"Как показывать в приложении\"'), 'wide') +\n      field('Ник в Telegram', input('Telegram', o['Telegram'] || '', 'placeholder=\"без @\"')) +\n      field('Telegram ID', input('Telegram ID', o['Telegram ID'] || '', 'inputmode=\"numeric\" placeholder=\"если нет ника\"')) +\n      field('Телефон', input('Телефон', o['Телефон'] || '')) +\n      '<div></div>' +\n      '<div class=\"field wide\"><label>Роли</label><div class=\"checks\">' +\n      ['Пилот', 'Менеджер', 'Руководство'].map((r) => '<label class=\"check\"><input type=\"checkbox\" name=\"' + r + '\"' + (yes(o[r]) ? ' checked' : '') + '>' + r + '</label>').join('') +\n      '<label class=\"check\"><input type=\"checkbox\" name=\"Активен\"' + (String(o['Активен'] || '').trim().toLowerCase() !== 'нет' ? ' checked' : '') + '>Активен (есть доступ к приложению)</label></div></div>' +\n      '</div><div class=\"err\" id=\"err\"></div>' +\n      '<div class=\"actions\">' + (p ? '<button type=\"button\" class=\"btn danger\" id=\"del\">Удалить</button>' : '') + '<div class=\"spacer\"></div><button type=\"button\" class=\"btn ghost\" data-close>Отмена</button><button class=\"btn\" id=\"save\">Сохранить</button></div></form>');\n    $$('[data-close]', d).forEach((x) => (x.onclick = closeDrawer));\n    $('#f', d).onsubmit = async (e) => {\n      e.preventDefault();\n      const v = formValues($('.grid', d));\n      const err = $('#err', d);\n      v['Telegram'] = v['Telegram'].replace(/^@/, '').replace(/^https?:\\/\\/t\\.me\\//i, '');\n      if (!v['Telegram'] && !v['Telegram ID']) return (err.textContent = 'Укажите ник в Telegram или Telegram ID.');\n      if (v['Telegram ID'] && !/^\\d+$/.test(v['Telegram ID'])) return (err.textContent = 'Telegram ID — только цифры.');\n      const keys = [norm(v['Telegram']), norm(v['Telegram ID'])].filter(Boolean);\n      const dup = people().find((x, j) => j !== i && x.keys.some((k) => keys.indexOf(k) >= 0));\n      if (dup) return (err.textContent = 'Такой ник или ID уже есть у «' + dup.name + '».');\n      ['Пилот', 'Менеджер', 'Руководство', 'Активен'].forEach((r) => (v[r] = v[r] ? 'Да' : 'Нет'));\n      $('#save', d).disabled = true;\n      const ok = await replace('Люди', p ? [p.raw] : [], [Object.assign({}, o, v)], 'Сохранено');\n      if (!ok && $('#save', d)) $('#save', d).disabled = false;\n    };\n    const del = $('#del', d);\n    if (del) del.onclick = async () => {\n      if (await confirmBox('Удалить «' + p.name + '»? Чтобы просто закрыть доступ, лучше снять галочку «Активен».')) replace('Люди', [p.raw], [], 'Удалено');\n    };\n  }\n\n  // ---- Чемпионаты ----\n  function champsView() {\n    const list = objects('Чемпионаты').filter((x) => String(x.obj['Чемпионат'] || '').trim());\n    return '<h1>Чемпионаты</h1><div class=\"hint\" style=\"margin:-6px 0 14px\">Список для выбора в гонках. Переименование не меняет уже созданные гонки.</div>' +\n      toolbar('Чемпионат') + '<div class=\"list\">' + (list.map((x, i) => match(x.obj['Чемпионат']) ?\n      '<div class=\"item static\" data-ch=\"' + i + '\"><div class=\"main\"><input class=\"input\" style=\"width:100%\" value=\"' + esc(x.obj['Чемпионат']) + '\" data-ch-name></div>' +\n      '<button class=\"btn ghost small\" data-ch-save>Сохранить</button><button class=\"btn danger small\" data-ch-del>Удалить</button></div>' : '').join('') || '<div class=\"empty\">Пока пусто</div>') + '</div>';\n  }\n  function bindChamps() {\n    const list = objects('Чемпионаты').filter((x) => String(x.obj['Чемпионат'] || '').trim());\n    $$('[data-ch]').forEach((el) => {\n      const x = list[Number(el.dataset.ch)];\n      $('[data-ch-save]', el).onclick = () => {\n        const name = $('[data-ch-name]', el).value.trim();\n        if (name) replace('Чемпионаты', [x.raw], [Object.assign({}, x.obj, { 'Чемпионат': name })], 'Сохранено');\n      };\n      $('[data-ch-del]', el).onclick = async () => {\n        if (await confirmBox('Удалить «' + x.obj['Чемпионат'] + '» из списка?')) replace('Чемпионаты', [x.raw], [], 'Удалено');\n      };\n    });\n  }\n  function addChamp() {\n    const d = openDrawer('<h2>Новый чемпионат<button class=\"btn ghost small x\" data-close>Закрыть</button></h2><form id=\"f\">' +\n      field('Название *', input('Чемпионат', '', 'required autofocus')) + '<div class=\"err\" id=\"err\"></div>' +\n      '<div class=\"actions\"><div class=\"spacer\"></div><button type=\"button\" class=\"btn ghost\" data-close>Отмена</button><button class=\"btn\">Добавить</button></div></form>');\n    $$('[data-close]', d).forEach((x) => (x.onclick = closeDrawer));\n    $('#f', d).onsubmit = (e) => {\n      e.preventDefault();\n      const v = formValues(d);\n      if (championships().indexOf(v['Чемпионат']) >= 0) return ($('#err', d).textContent = 'Такой уже есть.');\n      replace('Чемпионаты', [], [v], 'Добавлено');\n    };\n  }\n\n  // ---- Заработок ----\n  function incomeView() {\n    const ev = new Map(groupEvents('События').concat(groupEvents('Архив событий')).map((g) => [g.id, g]));\n    const list = objects('Заработок').map((x, i) => Object.assign(x, { i })).filter((x) => match([nameOf(x.obj['Менеджер']), x.obj['ID гонки'], x.obj['Комментарий']].join(' ')));\n    list.sort((a, b) => (String(a.obj['Дата записи']) < String(b.obj['Дата записи']) ? 1 : -1));\n    return '<h1>Заработок менеджеров</h1><div class=\"hint\" style=\"margin:-6px 0 14px\">Менеджеры вносят суммы сами в приложении. Здесь можно убрать ошибочную запись.</div>' +\n      toolbar('') + '<div class=\"list\">' + (list.map((x) => {\n        const g = ev.get(String(x.obj['ID гонки'] || '').trim());\n        return '<div class=\"item static\"><div class=\"main\"><div class=\"title\">' + esc(nameOf(x.obj['Менеджер'])) + ' — ' + esc(money(x.obj['Сумма'])) + '</div>' +\n          '<div class=\"meta\">' + esc([g ? g.title : x.obj['ID гонки'], String(x.obj['Дата записи'] || '').slice(0, 10), x.obj['Комментарий']].filter(Boolean).join(' · ')) + '</div></div>' +\n          '<button class=\"btn danger small\" data-inc=\"' + x.i + '\">Удалить</button></div>';\n      }).join('') || '<div class=\"empty\">Записей нет</div>') + '</div>';\n  }\n  function bindIncome() {\n    const rows = objects('Заработок');\n    $$('[data-inc]').forEach((b) => (b.onclick = async () => {\n      const x = rows[Number(b.dataset.inc)];\n      if (await confirmBox('Удалить запись ' + nameOf(x.obj['Менеджер']) + ' на ' + money(x.obj['Сумма']) + '?')) replace('Заработок', [x.raw], [], 'Удалено');\n    }));\n  }\n\n  // ---- Архив ----\n  function archiveView() {\n    const ev = groupEvents('Архив событий').filter((g) => match(g.id + ' ' + g.title));\n    const tr = trainings('Архив тренировок').filter((t) => match(t.id + ' ' + t.title));\n    const sort = (a, b) => (a.date < b.date ? 1 : -1);\n    const item = (x, kind) => '<div class=\"item static\"><div class=\"main\"><div class=\"title\">' + esc(x.title) + '</div><div class=\"meta\">' + esc(fmtDate(x.date)) + ' · ' + kind + ' · ' + esc(x.id) + '</div></div></div>';\n    return '<h1>Архив</h1><div class=\"hint\" style=\"margin:-6px 0 14px\">Сюда скрипт сам переносит гонки и тренировки, прошедшие больше недели назад. Они остаются в «Прошедших» и в финансах приложения.</div>' +\n      toolbar('') + '<div class=\"box\"><h3>Гонки (' + ev.length + ')</h3>' + (ev.sort(sort).map((g) => item(g, 'гонка')).join('') || '<div class=\"hint\">Пусто</div>') + '</div>' +\n      '<div class=\"box\"><h3>Тренировки (' + tr.length + ')</h3>' + (tr.sort(sort).map((t) => item(t, 'тренировка')).join('') || '<div class=\"hint\">Пусто</div>') + '</div>';\n  }\n\n  $('#reload').onclick = () => { load(); toast('Обновлено'); };\n  load();\n})();\n</script>\n</body>\n</html>\n";
