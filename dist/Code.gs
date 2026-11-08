// M-ELVN Mini App — код для Google Apps Script (Расширения → Apps Script).
// Файл собран автоматически из src/logic.js, src/gas-main.js, src/gas-admin.js и admin/, правьте исходники.
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
// Готовая копия таблицы для экрана приложения хранится в кэше Google 10 минут и
// сбрасывается при любой правке: из приложения, админ-панели или руками в таблице.
const CACHE_SECONDS = 600;
const CACHE_CHUNK = 40000; // в одной ячейке кэша до 100 КБ, кириллица — 2 байта на букву
const HISTORY_SHEET = 'История действий';
const HISTORY_HEADERS = ['Время', 'Кто', 'Telegram', 'Действие', 'Подробности'];
const HISTORY_HINTS = ['Московское время', 'Имя с листа «Люди»', 'Ник или ID', '', 'Лист очищается сам раз в 3 дня'];
const HISTORY_KEEP_DAYS = 3;

function doGet(e) {
  const initData = (e && e.parameter && e.parameter.initData) || '';
  // Без подписи Telegram это не приложение, а браузер: показываем админ-панель (только владельцу).
  if (!initData && e && e.parameter && e.parameter.admin !== undefined) return adminPage_();
  const user = verifyInitData(initData, botToken());
  if (!user) return jsonOut({ error: 'not_telegram' });
  try {
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
    const view = buildView(readSheetsCached(), user, TIMEZONE);
    if (!action) logOpen_(view, user);
    return jsonOut(view);
  } catch (err) {
    // Подробности ошибки — только в журнал скрипта, наружу не отдаём.
    console.error(err);
    return jsonOut({ error: 'sheet_unavailable' });
  }
}

// Данные для экрана приложения: из кэша, а если его нет — из таблицы (и кладём в кэш).
// Для записи (заработок, тренировки, настройки) таблица читается всегда напрямую.
function readSheetsCached() {
  const cache = CacheService.getScriptCache();
  const key = 'sheets:' + dataVersion_();
  try {
    const count = Number(cache.get(key) || 0);
    if (count) {
      const keys = [];
      for (let i = 0; i < count; i++) keys.push(key + ':' + i);
      const parts = cache.getAll(keys);
      if (keys.every(function (k) { return typeof parts[k] === 'string'; })) {
        return JSON.parse(keys.map(function (k) { return parts[k]; }).join(''));
      }
    }
  } catch (err) {
    console.error(err);
  }
  // Лист «Тренировки» появляется сам при первом открытии приложения после обновления скрипта.
  ensureSheet(TRAININGS_SHEET, TRAININGS_HEADERS, TRAININGS_HINTS);
  const data = readSheets();
  try {
    const json = JSON.stringify(data);
    const put = {};
    let n = 0;
    for (let i = 0; i < json.length; i += CACHE_CHUNK) put[key + ':' + n++] = json.slice(i, i + CACHE_CHUNK);
    put[key] = String(n);
    cache.putAll(put, CACHE_SECONDS);
  } catch (err) {
    console.error(err);
  }
  return data;
}

// Номер версии данных: меняется при каждой правке, и старый кэш больше не используется.
function dataVersion_() {
  return PropertiesService.getScriptProperties().getProperty('data_version') || '0';
}
function dropCache() {
  try {
    PropertiesService.getScriptProperties().setProperty('data_version', Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  } catch (err) {
    console.error(err);
  }
}

// Правка руками в таблице тоже сбрасывает кэш (простой триггер Google, настраивать не нужно).
function onEdit() {
  dropCache();
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
      const race = eventsWithArchive(data).find(function (x) { return x.id === raceId; });
      dropCache();
      logAction_(person, user, 'Внёс заработок', amount + ' ₽ — ' + (race ? race.title : raceId) + (p.note ? ' (' + String(p.note).slice(0, 200) + ')' : ''));
      return null;
    }

    // deleteIncome: удалить можно только свою запись.
    const id = String(p.id || '').trim();
    const values = sh.getDataRange().getDisplayValues();
    for (let i = values.length - 1; i >= 2; i--) {
      if (values[i][0] === id && person.keys.includes(normHandle(values[i][2]))) {
        sh.deleteRow(i + 1);
        dropCache();
        logAction_(person, user, 'Удалил запись о заработке', values[i][4] + ' ₽ — гонка ' + values[i][3]);
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
    dropCache();
    const training = trainingsWithArchive(data).find(function (x) { return x.id === trainingId; });
    const title = training ? training.title + ', ' + Utilities.formatDate(new Date(Date.UTC(training.date.y, training.date.m - 1, training.date.d, 12)), TIMEZONE, 'dd.MM.yyyy') : trainingId;
    if (action === 'signTraining') {
      sh.appendRow([Utilities.getUuid(), new Date().toISOString(), safeCell(person.key), safeCell(trainingId), Number(p.laps)]);
      logAction_(person, user, 'Записался на тренировку', title + ' — заездов: ' + Number(p.laps));
    } else {
      logAction_(person, user, 'Отменил запись на тренировку', title);
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
    dropCache();
    logAction_(person, user, 'Изменил напоминания',
      'гонки: ' + (p.racesOn === '1' ? 'за ' + racesLead.text : 'выкл') + '; тренировки: ' + (p.trainingsOn === '1' ? 'за ' + trainingsLead.text : 'выкл'));
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
    try {
      collectChats_(token);
    } catch (err) {
      console.error(err);
    }
    // Через кэш: заодно таймер каждые 5 минут держит кэш тёплым для приложения.
    const data = readSheetsCached();
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
    if (due.length) logAction_(null, null, 'Бот отправил напоминания', 'Сообщений: ' + due.length);
    // Журнал не растёт бесконечно: старые записи удаляются.
    if (logged.length > 3000) log.deleteRows(3, logged.length - 2000);
  } finally {
    lock.releaseLock();
  }
}

// Telegram ID людей, открывавших приложение: нужны, чтобы бот мог написать тем, у кого в «Людях» только ник.
function chatIds_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty('chat_ids') || '{}');
  } catch (err) {
    return {};
  }
}
// Telegram не даёт боту узнать ID человека по нику. Но каждый, кто пишет боту (в том числе
// нажимает «Старт»), присылает свой ник и ID. Таймер каждые 5 минут забирает эти сообщения
// и запоминает «ник → ID», чтобы бот мог писать людям, у которых в «Людях» указан только ник.
function collectChats_(token) {
  const props = PropertiesService.getScriptProperties();
  const offset = Number(props.getProperty('tg_offset') || 0);
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates?timeout=0&limit=100' +
    (offset ? '&offset=' + offset : ''), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return 0;
  const updates = (JSON.parse(res.getContentText()).result) || [];
  if (!updates.length) return 0;
  const ids = chatIds_();
  let changed = 0;
  updates.forEach(function (u) {
    const m = u.message || u.edited_message || u.my_chat_member || u.callback_query || {};
    const from = m.from;
    if (!from || from.is_bot || !from.username) return;
    const key = normHandle(from.username);
    const id = String(Number(from.id) || '');
    if (key && id && ids[key] !== id) { ids[key] = id; changed++; }
  });
  if (changed) props.setProperty('chat_ids', JSON.stringify(ids));
  props.setProperty('tg_offset', String(updates[updates.length - 1].update_id + 1));
  return changed;
}
function rememberChat_(me, user) {
  const id = String(Number(user.id) || '');
  if (!id || !me || !me.key) return;
  const ids = chatIds_();
  if (ids[me.key] === id) return;
  ids[me.key] = id;
  PropertiesService.getScriptProperties().setProperty('chat_ids', JSON.stringify(ids));
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
  dropCache();
  logAction_(null, null, 'Перенёс в архив', from + ' → ' + to + ': ' + Array.from(old).join(', '));
}

// ---- История действий ----
// Каждое действие — строка на листе «История действий». Раз в 3 дня лист очищается целиком.
// Ошибка записи в историю не должна мешать самому действию.
function logAction_(person, user, action, details) {
  try {
    const sh = ensureSheet(HISTORY_SHEET, HISTORY_HEADERS, HISTORY_HINTS);
    clearHistoryIfDue_(sh);
    const who = person ? person.name : user ? 'Не из команды' : 'Скрипт';
    const tg = user ? user.label || (user.username ? '@' + user.username : 'ID ' + user.id) : '';
    sh.appendRow([
      "'" + Utilities.formatDate(new Date(), TIMEZONE, 'dd.MM.yyyy HH:mm:ss'),
      safeCell(who),
      safeCell(tg),
      safeCell(action),
      safeCell(String(details || '').slice(0, 500)),
    ]);
  } catch (err) {
    console.error(err);
  }
}

// Открытие приложения пишем не чаще раза в 10 минут на человека, чтобы не засорять историю.
function logOpen_(view, user) {
  const cache = CacheService.getScriptCache();
  const k = 'open:' + user.id;
  if (cache.get(k)) return;
  cache.put(k, '1', 600);
  if (view.access) {
    try {
      rememberChat_(view.me, user);
    } catch (err) {
      console.error(err);
    }
    logAction_({ name: view.me.name }, user, 'Открыл приложение', '');
  }
  else logAction_(null, user, 'Попытка входа без доступа', 'Нет на листе «Люди» или «Активен» = Нет');
}

function clearHistoryIfDue_(sh) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const last = Number(props.getProperty('history_cleared_at') || 0);
  if (!last) {
    props.setProperty('history_cleared_at', String(now));
    return;
  }
  if (now - last < HISTORY_KEEP_DAYS * 24 * 3600 * 1000) return;
  props.setProperty('history_cleared_at', String(now));
  const rows = sh.getDataRange().getDisplayValues().length;
  if (rows <= 2) return;
  if (sh.getMaxRows() - (rows - 2) <= sh.getFrozenRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);
  sh.deleteRows(3, rows - 2);
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
  // Читаем только строку заголовков, а не весь лист.
  const width = Math.max(1, sh.getLastColumn());
  const have = sh.getRange(1, 1, 1, width).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
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
  'Архив событий', 'Архив тренировок', 'История действий',
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
    dropCache();
    logAdminChange_(sheetName, headers, oldRows, newRows);
  } finally {
    lock.releaseLock();
  }
  return admin_load();
}

// Запись в историю: что за объект и какие поля поменялись.
function logAdminChange_(sheetName, headers, oldRows, newRows) {
  const asObj = function (r) {
    const o = {};
    headers.forEach(function (h, i) { if (h) o[h] = String(r[i] === undefined ? '' : r[i]); });
    return o;
  };
  const before = oldRows[0] ? asObj(oldRows[0]) : null;
  const after = newRows[0] || null;
  const label = function (o) {
    if (!o) return '';
    return String(o['Название'] || o['ID'] || o['Имя'] || o['Чемпионат'] || o['Telegram'] || '').trim();
  };
  const verb = !before ? 'добавил' : !after ? 'удалил' : 'изменил';
  const what = { 'Люди': 'человека', 'События': 'гонку', 'Чемпионаты': 'чемпионат', 'Тренировки': 'тренировку',
    'Записи на тренировки': 'запись на тренировку', 'Заработок': 'запись о заработке' }[sheetName] || sheetName;
  let details = label(after) || label(before);
  if (before && after) {
    const changes = [];
    Object.keys(after).forEach(function (h) {
      const a = String(before[h] === undefined ? '' : before[h]);
      const b = String(after[h] === undefined ? '' : after[h]);
      if (a !== b) changes.push(h + ': «' + a + '» → «' + b + '»');
    });
    if (sheetName === 'События') {
      // Составы лежат в нескольких строках: сравниваем всех пилотов и менеджеров гонки.
      ['Пилоты', 'Менеджер'].forEach(function (h) {
        const list = function (rows) {
          return rows.map(function (r) { return String(r[h] === undefined ? '' : r[h]); }).join(',').split(/[,;\n]+/)
            .map(function (x) { return x.trim(); }).filter(Boolean).sort().join(', ');
        };
        const a = list(oldRows.map(asObj));
        const b = list(newRows);
        if (a !== b && changes.every(function (c) { return c.indexOf(h + ':') !== 0; })) changes.push(h + ': «' + a + '» → «' + b + '»');
      });
    }
    details += changes.length ? ' — ' + changes.join('; ') : ' — без изменений в основной строке';
  }
  logAction_({ name: 'Админ-панель' }, { label: Session.getActiveUser().getEmail() }, 'Админ ' + verb + ' ' + what, details);
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

// ---- Результаты тренировки ----
// Страницы заезда и карта с timing.batyrshin.name. Браузер панели не может открыть их сам
// (чужой сайт), поэтому скрипт скачивает страницу и отдаёт её текст, а разбирает панель.
const TIMING_URL = /^https:\/\/timing\.batyrshin\.name\/tracks\/[a-z0-9_-]+\/(heats|karts)\/[0-9a-z_-]+\/?(\?[^#]*)?$/i;

function admin_timing(url) {
  if (!isOwner_()) throw new Error('Нет доступа');
  url = String(url || '').trim().replace(/^http:/i, 'https:').replace(/#.*$/, '');
  if (!TIMING_URL.test(url)) return { error: 'bad_url' };
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  const code = res.getResponseCode();
  if (code !== 200) return { error: 'http_' + code };
  return { url: url, html: res.getContentText('UTF-8').slice(0, 3000000) };
}

// Отправка картинок с результатами. items: [{key: ник или ID из «Людей», images: [base64 PNG], caption}].
function admin_sendResults(items) {
  if (!isOwner_()) throw new Error('Нет доступа');
  const token = botToken();
  if (!token) throw new Error('Не задан BOT_TOKEN');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const read = function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return [];
    const v = sh.getDataRange().getDisplayValues();
    const h = (v[0] || []).map(function (x) { return String(x).trim(); });
    return v.slice(2).map(function (r) { const o = {}; h.forEach(function (k, i) { if (k) o[k] = String(r[i]).trim(); }); return o; });
  };
  const people = buildPeople(read('Люди'));
  const settings = read(SETTINGS_SHEET);
  try {
    collectChats_(token);
  } catch (err) {
    console.error(err);
  }
  const ids = chatIds_();
  const out = [];
  const sentTo = [];
  (items || []).slice(0, 30).forEach(function (it) {
    const p = people.find(function (x) { return x.keys.indexOf(normHandle(it.key)) >= 0; });
    if (!p) { out.push({ key: it.key, error: 'not_found' }); return; }
    const chatId = p.keys.find(function (k) { return /^\d+$/.test(k); }) || findSettings(settings, p).chatId || p.keys.map(function (k) { return ids[k]; }).filter(Boolean)[0] || '';
    if (!/^\d+$/.test(chatId)) { out.push({ key: it.key, name: p.name, error: 'no_chat' }); return; }
    let code = 0;
    const images = (it.images || []).slice(0, 10);
    for (let i = 0; i < images.length; i++) {
      const blob = Utilities.newBlob(Utilities.base64Decode(String(images[i]).replace(/^data:image\/png;base64,/, '')), 'image/png', 'result-' + (i + 1) + '.png');
      try {
        code = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendPhoto', {
          method: 'post',
          muteHttpExceptions: true,
          payload: { chat_id: chatId, photo: blob, caption: i === 0 ? String(it.caption || '').slice(0, 1000) : '' },
        }).getResponseCode();
      } catch (err) {
        console.error(err);
        code = 0;
      }
      if (code !== 200) break;
    }
    if (code === 200) sentTo.push(p.name);
    out.push({ key: it.key, name: p.name, error: code === 200 ? '' : code === 403 ? 'blocked' : 'send_' + code });
  });
  if (sentTo.length) {
    logAction_({ name: 'Админ-панель' }, { label: Session.getActiveUser().getEmail() }, 'Админ отправил результаты тренировки', sentTo.join(', '));
  }
  return out;
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

// Страница админ-панели (из admin/admin.html и admin/results.js).
const ADMIN_HTML = "<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>M-ELVN — админ-панель</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Unbounded:wght@400;700&display=swap\" rel=\"stylesheet\">\n<style>\n  :root {\n    --orange: #ff5a00; --carbon: #101011; --white: #ffffff;\n    --bg: #1b1b1d; --bg3: #232326; --line: #2a2a2d; --hint: #9a9aa0; --danger: #ff4d4f;\n    color-scheme: dark;\n  }\n  * { box-sizing: border-box; }\n  body { margin: 0; background: var(--carbon); color: var(--white); font: 14px/1.45 -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }\n  button, input, select, textarea { font: inherit; color: inherit; }\n  .top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 12px 20px; background: var(--bg); border-bottom: 1px solid var(--line); }\n  .brand { font-weight: 800; letter-spacing: .04em; }\n  .brand::before { content: \"\"; display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--orange); margin-right: 8px; vertical-align: middle; }\n  .brand small { font-weight: 600; letter-spacing: 0; color: var(--hint); margin-left: 6px; }\n  .spacer { flex: 1; }\n  .me { color: var(--hint); font-size: 12px; }\n  .layout { display: flex; min-height: calc(100vh - 57px); }\n  nav { width: 200px; flex: none; padding: 14px 10px; border-right: 1px solid var(--line); }\n  nav button { display: flex; justify-content: space-between; width: 100%; text-align: left; border: 0; background: none; padding: 9px 12px; border-radius: 9px; color: var(--hint); font-weight: 600; cursor: pointer; }\n  nav button:hover { background: var(--bg); color: var(--white); }\n  nav button.on { background: var(--white); color: var(--carbon); }\n  nav .cnt { font-weight: 500; opacity: .7; }\n  main { flex: 1; min-width: 0; padding: 18px 22px 60px; max-width: 1100px; }\n  h1 { font-size: 22px; margin: 0 0 14px; }\n  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }\n  .input, select.input, textarea.input { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 8px 11px; min-width: 0; }\n  .input:focus { outline: none; border-color: var(--orange); }\n  textarea.input { width: 100%; min-height: 90px; resize: vertical; }\n  .search { flex: 1; min-width: 180px; }\n  .btn { border: 0; border-radius: 10px; padding: 9px 14px; background: var(--orange); color: var(--white); font-weight: 600; cursor: pointer; white-space: nowrap; }\n  .btn:disabled { opacity: .5; cursor: default; }\n  .btn.ghost { background: var(--line); }\n  .btn.danger { background: transparent; color: var(--danger); box-shadow: inset 0 0 0 1px var(--danger); }\n  .btn.small { padding: 5px 10px; font-size: 13px; }\n  .seg { display: inline-flex; background: var(--bg); border-radius: 10px; padding: 3px; }\n  .seg button { border: 0; background: none; padding: 6px 12px; border-radius: 8px; color: var(--hint); font-weight: 600; cursor: pointer; }\n  .seg button.on { background: var(--white); color: var(--carbon); }\n  .list { display: flex; flex-direction: column; gap: 8px; }\n  .item { display: flex; gap: 14px; align-items: center; width: 100%; text-align: left; border: 0; background: var(--bg); border-radius: 12px; padding: 11px 14px; cursor: pointer; }\n  .item:hover { background: var(--bg3); }\n  .item .main { flex: 1; min-width: 0; }\n  .item .title { font-weight: 600; }\n  .item .meta { color: var(--hint); font-size: 13px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; }\n  .item .side { color: var(--hint); font-size: 13px; text-align: right; white-space: nowrap; }\n  .item.static { cursor: default; }\n  .item.static:hover { background: var(--bg); }\n  .champ { color: var(--orange); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }\n  .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }\n  .badge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: 6px; background: var(--line); color: var(--hint); white-space: nowrap; }\n  .badge.race { background: var(--orange); color: var(--white); }\n  .badge.off { background: #777; color: #fff; }\n  .badge.warn { background: transparent; color: var(--orange); box-shadow: inset 0 0 0 1px var(--orange); }\n  .empty { color: var(--hint); padding: 30px 0; text-align: center; }\n  .cancelled .title { text-decoration: line-through; }\n  /* Редактор */\n  .shade { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 20; display: flex; justify-content: flex-end; }\n  .drawer { width: min(640px, 100%); height: 100%; overflow-y: auto; background: var(--carbon); border-left: 1px solid var(--line); padding: 20px 22px 30px; }\n  .drawer h2 { margin: 0 0 16px; font-size: 20px; display: flex; align-items: center; gap: 10px; }\n  .drawer h2 .x { margin-left: auto; }\n  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; }\n  .grid .wide { grid-column: 1 / -1; }\n  .field label { display: block; font-size: 12px; color: var(--hint); margin-bottom: 4px; font-weight: 600; }\n  .field .input { width: 100%; }\n  .req::after { content: \" *\"; color: var(--orange); }\n  .box { background: var(--bg); border-radius: 12px; padding: 12px 14px; margin-top: 14px; }\n  .box h3 { margin: 0 0 10px; font-size: 12px; color: var(--hint); text-transform: uppercase; letter-spacing: .04em; display: flex; align-items: center; gap: 8px; }\n  .box h3 .btn { margin-left: auto; }\n  .crew { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-top: 10px; }\n  .crew-head { display: flex; gap: 8px; align-items: center; }\n  .crew-head .input { flex: 1; }\n  .who { margin-top: 10px; }\n  .who > span { display: block; font-size: 12px; color: var(--hint); margin-bottom: 4px; font-weight: 600; }\n  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }\n  .chip { display: inline-flex; align-items: center; gap: 4px; background: var(--bg3); border-radius: 999px; padding: 4px 6px 4px 11px; font-size: 13px; }\n  .chip.unknown { box-shadow: inset 0 0 0 1px var(--orange); }\n  .chip button { border: 0; background: none; color: var(--hint); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; }\n  .chips select { background: var(--carbon); border: 1px dashed var(--line); border-radius: 999px; padding: 4px 10px; color: var(--hint); font-size: 13px; max-width: 220px; }\n  .checks { display: flex; flex-wrap: wrap; gap: 14px; }\n  .check { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }\n  .check input { width: 17px; height: 17px; accent-color: var(--orange); }\n  .actions { display: flex; gap: 8px; margin-top: 20px; position: sticky; bottom: -30px; padding: 12px 0; background: var(--carbon); }\n  .actions .spacer { flex: 1; }\n  .err { color: var(--orange); font-size: 13px; margin-top: 10px; min-height: 1em; }\n  .row-line { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--line); }\n  .row-line:first-of-type { border-top: 0; }\n  .row-line .grow { flex: 1; min-width: 0; }\n  .hint { color: var(--hint); font-size: 12px; }\n  .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: var(--white); color: var(--carbon); padding: 10px 16px; border-radius: 10px; font-weight: 600; z-index: 40; box-shadow: 0 6px 24px rgba(0,0,0,.4); max-width: calc(100% - 32px); }\n  .toast.bad { background: var(--orange); color: var(--white); }\n  .loading { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--hint); }\n  .modal { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; padding: 16px; }\n  .modal > div { background: var(--bg); border-radius: 14px; padding: 18px; max-width: 380px; width: 100%; }\n  .modal p { margin: 0 0 16px; }\n  .modal .actions { position: static; margin: 0; padding: 0; background: none; justify-content: flex-end; }\n  .previews { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }\n  .previews figure { margin: 0; }\n  .previews figcaption { font-size: 12px; color: var(--hint); margin-bottom: 6px; }\n  canvas.preview { width: 100%; height: auto; border-radius: 10px; display: block; }\n  @media (max-width: 760px) {\n    .layout { flex-direction: column; }\n    nav { width: auto; display: flex; gap: 4px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 8px 12px; }\n    nav button { width: auto; flex: none; gap: 6px; }\n    main { padding: 14px 14px 60px; }\n    .grid { grid-template-columns: 1fr; }\n    .me { display: none; }\n    .top { padding: 12px 14px; }\n    .drawer { padding: 16px 14px 30px; }\n  }\n</style>\n</head>\n<body>\n<header class=\"top\">\n  <div class=\"brand\">M-ELVN<small>админ-панель</small></div>\n  <div class=\"spacer\"></div>\n  <span class=\"me\" id=\"me\"></span>\n  <a class=\"btn ghost small\" id=\"sheet-link\" target=\"_blank\" rel=\"noopener\" style=\"text-decoration:none\" hidden>Таблица</a>\n  <button class=\"btn ghost small\" id=\"reload\">Обновить</button>\n</header>\n<div class=\"layout\">\n  <nav id=\"nav\"></nav>\n  <main id=\"main\"><div class=\"loading\">Загрузка…</div></main>\n</div>\n<div id=\"layer\"></div>\n<script>\n(function () {\n  'use strict';\n  // ---- Связь с таблицей ----\n  function call(fn) {\n    const args = Array.prototype.slice.call(arguments, 1);\n    return new Promise(function (resolve, reject) {\n      google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn].apply(null, args);\n    });\n  }\n\n  const esc = (s) => String(s == null ? '' : s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  const $ = (sel, root) => (root || document).querySelector(sel);\n  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));\n  const yes = (v) => ['да', 'yes', 'true', '1', '+', 'x', 'х'].indexOf(String(v || '').trim().toLowerCase()) >= 0;\n  const norm = (v) => String(v || '').trim().replace(/^@/, '').replace(/^https?:\\/\\/t\\.me\\//i, '').toLowerCase();\n  const split = (v) => String(v || '').split(/[,;\\n]+/).map((x) => x.trim().replace(/^@/, '')).filter(Boolean);\n\n  // Даты: в таблице «ДД.ММ.ГГГГ», в полях формы «ГГГГ-ММ-ДД».\n  function toIso(v) {\n    const s = String(v || '').trim();\n    let m = s.match(/^(\\d{1,2})[./-](\\d{1,2})[./-](\\d{4})$/);\n    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');\n    m = s.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/);\n    return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : '';\n  }\n  const fromIso = (iso) => (iso ? iso.split('-').reverse().join('.') : '');\n  const toTime = (v) => {\n    const m = String(v || '').trim().match(/^(\\d{1,2})[:.](\\d{2})/);\n    return m ? m[1].padStart(2, '0') + ':' + m[2] : '';\n  };\n  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];\n  const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];\n  function fmtDate(iso) {\n    if (!iso) return 'без даты';\n    const p = iso.split('-').map(Number);\n    return p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0] + ', ' + DAYS[new Date(p[0], p[1] - 1, p[2]).getDay()];\n  }\n  const today = () => {\n    const t = new Date();\n    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');\n  };\n  const money = (v) => {\n    const n = Number(String(v || '').replace(/[\\s ]/g, '').replace(/[.,](?=\\d{3}(?:[.,]|$))/g, '').replace(',', '.').match(/\\d+(?:\\.\\d+)?/));\n    return isFinite(n) && n ? Math.round(n).toLocaleString('ru-RU') + ' ₽' : String(v || '');\n  };\n\n  // ---- Данные ----\n  let data = null;\n  let section = 'events';\n  const ui = { q: '', when: 'upcoming', champ: '', who: '', kind: '', historyLimit: 200 };\n\n  function sheet(name) {\n    return (data && data.sheets[name]) || { headers: [], rows: [] };\n  }\n  function objects(name) {\n    const s = sheet(name);\n    return s.rows.map((r) => {\n      const o = {};\n      s.headers.forEach((h, i) => { if (h) o[h] = r[i] == null ? '' : String(r[i]); });\n      return { obj: o, raw: r };\n    });\n  }\n\n  function people() {\n    return objects('Люди').map((x) => {\n      const o = x.obj;\n      const key = norm(o['Telegram']) || norm(o['Telegram ID']);\n      return {\n        raw: x.raw, obj: o, key, keys: [norm(o['Telegram']), norm(o['Telegram ID'])].filter(Boolean),\n        name: o['Имя'] || (key ? '@' + key : '—'),\n        pilot: yes(o['Пилот']), manager: yes(o['Менеджер']), lead: yes(o['Руководство']),\n        active: String(o['Активен'] || '').trim().toLowerCase() !== 'нет',\n      };\n    });\n  }\n  function nameOf(handle) {\n    const k = norm(handle);\n    const p = people().find((x) => x.keys.indexOf(k) >= 0);\n    return p ? p.name : '@' + handle;\n  }\n\n  // Гонка = все строки с одним ID: первая с датой — основная, каждая строка — состав.\n  function groupEvents(name) {\n    const map = new Map();\n    objects(name).forEach((x) => {\n      const id = String(x.obj['ID'] || '').trim();\n      if (!id) return;\n      if (!map.has(id)) map.set(id, { id, rows: [], base: null, crews: [] });\n      const g = map.get(id);\n      g.rows.push(x);\n      if (!g.base || (!toIso(g.base['Дата']) && toIso(x.obj['Дата']))) g.base = x.obj;\n      const crew = { name: x.obj['Состав'] || '', managers: split(x.obj['Менеджер']), pilots: split(x.obj['Пилоты']) };\n      if (crew.name || crew.managers.length || crew.pilots.length) g.crews.push(crew);\n    });\n    return Array.from(map.values()).map((g) => {\n      const b = g.base;\n      const stage = String(b['Этап'] || '').trim();\n      const stageText = /^\\d+$/.test(stage) ? (/трен/i.test(b['Тип']) ? 'Тренировка ' : 'Этап ') + stage : stage;\n      g.date = toIso(b['Дата']);\n      g.title = b['Название'] || [b['Чемпионат'], stageText].filter(Boolean).join(' — ') || g.id;\n      g.cancelled = String(b['Статус'] || '').trim().toLowerCase().indexOf('отмен') === 0;\n      return g;\n    });\n  }\n\n  function trainings(name) {\n    return objects(name).filter((x) => String(x.obj['ID'] || '').trim()).map((x) => {\n      const o = x.obj;\n      return {\n        raw: x.raw, obj: o, id: String(o['ID']).trim(), date: toIso(o['Дата']),\n        title: o['Название'] || o['Тип'] || 'Тренировка',\n        cancelled: String(o['Статус'] || '').trim().toLowerCase().indexOf('отмен') === 0,\n      };\n    });\n  }\n  function signups() {\n    return objects('Записи на тренировки').map((x) => ({ raw: x.raw, obj: x.obj, training: String(x.obj['ID тренировки'] || '').trim() }));\n  }\n\n  // ---- Сохранение ----\n  async function replace(sheetName, oldRows, newRows, okText) {\n    try {\n      const res = await call('admin_replace', sheetName, oldRows, newRows);\n      if (res && res.error === 'conflict') {\n        toast('Пока вы редактировали, эти строки поменяли в таблице. Данные обновлены — повторите правку.', true);\n        await load();\n        return false;\n      }\n      data = res;\n      closeDrawer();\n      render();\n      toast(okText || 'Сохранено');\n      return true;\n    } catch (e) {\n      toast('Не удалось сохранить: ' + (e && e.message ? e.message : e), true);\n      return false;\n    }\n  }\n\n  async function load() {\n    try {\n      data = await call('admin_load');\n      $('#me').textContent = data.me || '';\n      if (data.url) {\n        $('#sheet-link').href = data.url;\n        $('#sheet-link').hidden = false;\n      }\n      render();\n    } catch (e) {\n      $('#main').innerHTML = '<div class=\"empty\">Не удалось загрузить данные: ' + esc(e && e.message ? e.message : e) + '</div>';\n    }\n  }\n\n  // ---- Общие элементы ----\n  let toastTimer = null;\n  function toast(text, bad) {\n    let t = $('.toast');\n    if (!t) {\n      t = document.createElement('div');\n      document.body.appendChild(t);\n    }\n    t.className = 'toast' + (bad ? ' bad' : '');\n    t.textContent = text;\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(() => t.remove(), bad ? 6000 : 2500);\n  }\n\n  function confirmBox(text, okLabel) {\n    return new Promise((resolve) => {\n      const m = document.createElement('div');\n      m.className = 'modal';\n      m.innerHTML = '<div><p>' + esc(text) + '</p><div class=\"actions\"><button class=\"btn ghost\" data-no>Отмена</button><button class=\"btn\" data-yes>' + esc(okLabel || 'Удалить') + '</button></div></div>';\n      document.body.appendChild(m);\n      const done = (v) => { m.remove(); resolve(v); };\n      $('[data-no]', m).onclick = () => done(false);\n      $('[data-yes]', m).onclick = () => done(true);\n      m.onclick = (e) => { if (e.target === m) done(false); };\n    });\n  }\n\n  function openDrawer(html) {\n    $('#layer').innerHTML = '<div class=\"shade\"><div class=\"drawer\">' + html + '</div></div>';\n    const shade = $('#layer .shade');\n    shade.addEventListener('mousedown', (e) => { if (e.target === shade) closeDrawer(); });\n    $$('[data-close]', shade).forEach((b) => (b.onclick = closeDrawer));\n    return $('.drawer', shade);\n  }\n  function closeDrawer() {\n    $('#layer').innerHTML = '';\n  }\n  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('.modal')) closeDrawer(); });\n\n  const field = (label, html, cls) => '<div class=\"field ' + (cls || '') + '\"><label class=\"' + (/\\*$/.test(label) ? 'req' : '') + '\">' + esc(label.replace(/\\s*\\*$/, '')) + '</label>' + html + '</div>';\n  const input = (name, value, attrs) => '<input class=\"input\" name=\"' + esc(name) + '\" value=\"' + esc(value) + '\" ' + (attrs || '') + '>';\n  const select = (name, value, options, attrs) => {\n    const opts = options.slice();\n    if (value && opts.indexOf(value) < 0) opts.unshift(value);\n    return '<select class=\"input\" name=\"' + esc(name) + '\" ' + (attrs || '') + '>' + opts.map((o) => '<option value=\"' + esc(o) + '\"' + (o === value ? ' selected' : '') + '>' + esc(o || '—') + '</option>').join('') + '</select>';\n  };\n  const formValues = (root) => {\n    const o = {};\n    $$('[name]', root).forEach((el) => { o[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim(); });\n    return o;\n  };\n  const championships = () => objects('Чемпионаты').map((x) => String(x.obj['Чемпионат'] || '').trim()).filter(Boolean);\n  const tracks = () => {\n    const set = new Set();\n    groupEvents('События').forEach((g) => g.base['Трасса'] && set.add(g.base['Трасса']));\n    trainings('Тренировки').forEach((t) => t.obj['Трасса'] && set.add(t.obj['Трасса']));\n    return Array.from(set).sort();\n  };\n  const datalist = (id, items) => '<datalist id=\"' + id + '\">' + items.map((x) => '<option value=\"' + esc(x) + '\">').join('') + '</datalist>';\n\n  // ---- Навигация ----\n  const SECTIONS = [\n    ['events', 'Гонки'], ['trainings', 'Тренировки'], ['people', 'Люди'],\n    ['champs', 'Чемпионаты'], ['income', 'Заработок'], ['results', 'Результаты'], ['archive', 'Архив'], ['history', 'История'],\n  ];\n  function counts() {\n    return {\n      events: groupEvents('События').length,\n      trainings: trainings('Тренировки').length,\n      people: people().length,\n      champs: championships().length,\n      income: objects('Заработок').length,\n      archive: groupEvents('Архив событий').length + trainings('Архив тренировок').length,\n      history: objects('История действий').length,\n      results: res.heats.length || '',\n    };\n  }\n  function render() {\n    const c = counts();\n    $('#nav').innerHTML = SECTIONS.map((s) => '<button class=\"' + (s[0] === section ? 'on' : '') + '\" data-sec=\"' + s[0] + '\">' + s[1] + ' <span class=\"cnt\">' + c[s[0]] + '</span></button>').join('');\n    $$('[data-sec]').forEach((b) => (b.onclick = () => { section = b.dataset.sec; ui.q = ''; render(); }));\n    const m = $('#main');\n    m.innerHTML = ({ events: eventsView, trainings: trainingsView, people: peopleView, champs: champsView, income: incomeView, results: resultsView, archive: archiveView, history: historyView })[section]();\n    bindToolbar();\n    if (section === 'champs') bindChamps();\n    if (section === 'income') bindIncome();\n    if (section === 'history') bindHistory();\n    if (section === 'results') bindResults();\n  }\n\n  function toolbar(addLabel, extra) {\n    return '<div class=\"bar\"><input class=\"input search\" id=\"q\" placeholder=\"Поиск по названию\" value=\"' + esc(ui.q) + '\">' + (extra || '') + (addLabel ? '<button class=\"btn\" id=\"add\">+ ' + esc(addLabel) + '</button>' : '') + '</div>';\n  }\n  function bindToolbar() {\n    const q = $('#q');\n    if (q) {\n      q.oninput = () => {\n        ui.q = q.value;\n        const pos = q.selectionStart;\n        render();\n        const nq = $('#q');\n        nq.focus();\n        nq.setSelectionRange(pos, pos);\n      };\n    }\n    $$('[data-when]').forEach((b) => (b.onclick = () => { ui.when = b.dataset.when; render(); }));\n    const ch = $('#champ-filter');\n    if (ch) ch.onchange = () => { ui.champ = ch.value; render(); };\n    const add = $('#add');\n    if (add) add.onclick = () => ({ events: () => editEvent(null), trainings: () => editTraining(null), people: () => editPerson(null), champs: addChamp })[section]();\n    $$('[data-event]').forEach((b) => (b.onclick = () => editEvent(b.dataset.event)));\n    $$('[data-training]').forEach((b) => (b.onclick = () => editTraining(b.dataset.training)));\n    $$('[data-person]').forEach((b) => (b.onclick = () => editPerson(Number(b.dataset.person))));\n  }\n  const fold = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е');\n  const match = (text) => !ui.q.trim() || fold(text).indexOf(fold(ui.q.trim())) >= 0;\n  const whenSeg = () => '<div class=\"seg\">' + [['upcoming', 'Предстоящие'], ['past', 'Прошедшие'], ['all', 'Все']].map((w) => '<button class=\"' + (ui.when === w[0] ? 'on' : '') + '\" data-when=\"' + w[0] + '\">' + w[1] + '</button>').join('') + '</div>';\n  function byWhen(list) {\n    const t = today();\n    const key = (x) => (x.date || '9999') + ' ' + toTime((x.base || x.obj)['Начало']);\n    let out = list.filter((x) => ui.when === 'all' || (ui.when === 'upcoming' ? !x.date || x.date >= t : x.date && x.date < t));\n    out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));\n    if (ui.when === 'past') out.reverse();\n    return out;\n  }\n\n  // ---- Гонки ----\n  function eventsView() {\n    const champs = championships();\n    const list = byWhen(groupEvents('События')).filter((g) => (!ui.champ || g.base['Чемпионат'] === ui.champ) &&\n      match([g.id, g.title, g.base['Чемпионат'], g.base['Трасса']].concat(g.crews.map((c) => c.name + ' ' + c.pilots.concat(c.managers).map(nameOf).join(' '))).join(' ')));\n    const champSel = '<select class=\"input\" id=\"champ-filter\"><option value=\"\">Все чемпионаты</option>' + champs.map((c) => '<option' + (c === ui.champ ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>';\n    return '<h1>Гонки и назначенные тренировки</h1>' + toolbar('Гонка', whenSeg() + champSel) +\n      '<div class=\"list\">' + (list.map(eventItem).join('') || '<div class=\"empty\">Ничего не найдено</div>') + '</div>';\n  }\n  function eventItem(g) {\n    const b = g.base;\n    const pilots = g.crews.reduce((n, c) => n + c.pilots.length, 0);\n    const type = b['Тип'] || 'Событие';\n    const champ = b['Чемпионат'] && g.title.indexOf(b['Чемпионат']) !== 0 ? '<div class=\"champ\">' + esc(b['Чемпионат']) + '</div>' : '';\n    return '<button class=\"item ' + (g.cancelled ? 'cancelled' : '') + '\" data-event=\"' + esc(g.id) + '\"><div class=\"main\">' + champ +\n      '<div class=\"title\">' + esc(g.title) + '</div>' +\n      '<div class=\"meta\">' + esc([fmtDate(g.date), toTime(b['Начало']), b['Трасса']].filter(Boolean).join(' · ')) + '</div>' +\n      '<div class=\"badges\">' + (g.cancelled ? '<span class=\"badge off\">Отменено</span>' : '<span class=\"badge ' + (/гонк/i.test(type) ? 'race' : '') + '\">' + esc(type) + '</span>') +\n      (b['Формат'] ? '<span class=\"badge\">' + esc(b['Формат']) + '</span>' : '') + (!g.date ? '<span class=\"badge warn\">Нет даты — в приложении не видна</span>' : '') + '</div></div>' +\n      '<div class=\"side\">' + esc(g.id) + '<br>' + (g.crews.length > 1 ? g.crews.length + ' сост. · ' : '') + pilots + ' пил.</div></button>';\n  }\n\n  // Выбор людей: чипы и выпадающий список «добавить».\n  function picker(role, list) {\n    const ps = people().filter((p) => p.active).sort((a, b) => (b[role] - a[role]) || a.name.localeCompare(b.name, 'ru'));\n    const chips = list.map((h) => {\n      const known = people().some((p) => p.keys.indexOf(norm(h)) >= 0);\n      return '<span class=\"chip ' + (known ? '' : 'unknown') + '\" data-h=\"' + esc(h) + '\" title=\"' + (known ? '' : 'Нет на листе «Люди»') + '\">' + esc(nameOf(h)) + '<button type=\"button\" data-rm aria-label=\"Убрать\">×</button></span>';\n    }).join('');\n    const opts = ps.filter((p) => !list.some((h) => p.keys.indexOf(norm(h)) >= 0))\n      .map((p) => '<option value=\"' + esc(p.obj['Telegram'] || p.obj['Telegram ID']) + '\">' + esc(p.name) + (p[role] ? '' : ' (не ' + (role === 'pilot' ? 'пилот' : 'менеджер') + ')') + '</option>').join('');\n    return '<div class=\"chips\" data-picker=\"' + role + '\">' + chips + '<select data-addp><option value=\"\">+ добавить</option>' + opts + '</select></div>';\n  }\n  function pickerValues(root) {\n    return $$('.chip', root).map((c) => c.dataset.h);\n  }\n\n  function crewHtml(c, i) {\n    return '<div class=\"crew\" data-crew=\"' + i + '\"><div class=\"crew-head\">' +\n      '<input class=\"input\" data-crew-name placeholder=\"Название состава (если составов несколько)\" value=\"' + esc(c.name) + '\">' +\n      '<button type=\"button\" class=\"btn ghost small\" data-crew-del>Убрать состав</button></div>' +\n      '<div class=\"who\"><span>Пилоты</span>' + picker('pilot', c.pilots) + '</div>' +\n      '<div class=\"who\"><span>Менеджер</span>' + picker('manager', c.managers) + '</div></div>';\n  }\n\n  function editEvent(id) {\n    const g = id ? groupEvents('События').find((x) => x.id === id) : null;\n    const b = g ? g.base : { 'Тип': 'Гонка', 'Формат': 'Командная', 'Статус': 'Запланировано' };\n    let crews = g ? g.crews.map((c) => ({ name: c.name, pilots: c.pilots.slice(), managers: c.managers.slice() })) : [{ name: '', pilots: [], managers: [] }];\n    const champs = [''].concat(championships());\n    const d = openDrawer(\n      '<h2>' + (g ? esc(g.title) : 'Новая гонка') + '<button class=\"btn ghost small x\" data-close>Закрыть</button></h2>' +\n      '<form id=\"f\"><div class=\"grid\">' +\n      field('ID *', input('ID', g ? g.id : '', 'required placeholder=\"Например, ROTY272K\"')) +\n      field('Тип', select('Тип', b['Тип'] || '', ['Гонка', 'Тренировка'])) +\n      field('Чемпионат', select('Чемпионат', b['Чемпионат'] || '', champs)) +\n      field('Этап', input('Этап', b['Этап'] || '', 'placeholder=\"3, 2A, Финал\"')) +\n      field('Формат', select('Формат', b['Формат'] || '', ['Командная', 'Личная'])) +\n      field('Статус', select('Статус', b['Статус'] || '', ['Запланировано', 'Отменено'])) +\n      field('Название', input('Название', b['Название'] || '', 'placeholder=\"Если пусто — «Чемпионат — Этап»\"'), 'wide') +\n      field('Дата *', input('Дата', toIso(b['Дата']), 'type=\"date\" required')) +\n      field('Стоимость', input('Стоимость', b['Стоимость'] || '', 'placeholder=\"7500 Руб.\"')) +\n      field('Начало', input('Начало', toTime(b['Начало']), 'type=\"time\"')) +\n      field('Окончание', input('Окончание', toTime(b['Окончание']), 'type=\"time\"')) +\n      field('Трасса', input('Трасса', b['Трасса'] || '', 'list=\"tracks\"') + datalist('tracks', tracks())) +\n      field('Адрес', input('Адрес', b['Адрес'] || '')) +\n      field('Регламент', input('Регламент', b['Регламент'] || '', 'placeholder=\"Ссылка\"'), 'wide') +\n      field('Описание', '<textarea class=\"input\" name=\"Описание\">' + esc(b['Описание'] || '') + '</textarea>', 'wide') +\n      '</div><div class=\"box\"><h3>Составы<button type=\"button\" class=\"btn ghost small\" id=\"add-crew\">+ Состав</button></h3><div id=\"crews\"></div>' +\n      '<div class=\"hint\" style=\"margin-top:8px\">Пилоты и менеджер видят гонку в приложении. Оранжевая рамка — человека нет на листе «Люди».</div></div>' +\n      '<div class=\"err\" id=\"err\"></div>' +\n      '<div class=\"actions\">' + (g ? '<button type=\"button\" class=\"btn danger\" id=\"del\">Удалить гонку</button>' : '') + '<div class=\"spacer\"></div><button type=\"button\" class=\"btn ghost\" data-close>Отмена</button><button class=\"btn\" id=\"save\">Сохранить</button></div></form>');\n    $$('[data-close]', d).forEach((x) => (x.onclick = closeDrawer));\n\n    // Составы держим в массиве и перерисовываем.\n    const sync = () => {\n      crews = $$('[data-crew]', d).map((el) => ({\n        name: $('[data-crew-name]', el).value.trim(),\n        pilots: pickerValues($('[data-picker=\"pilot\"]', el)),\n        managers: pickerValues($('[data-picker=\"manager\"]', el)),\n      }));\n    };\n    const drawCrews = () => {\n      $('#crews', d).innerHTML = crews.map(crewHtml).join('') || '<div class=\"hint\">Составов нет — гонку увидит только руководство.</div>';\n      $$('[data-crew]', d).forEach((el, i) => {\n        $('[data-crew-del]', el).onclick = () => { sync(); crews.splice(i, 1); drawCrews(); };\n        $$('[data-rm]', el).forEach((x) => (x.onclick = () => { x.parentNode.remove(); sync(); drawCrews(); }));\n        $$('[data-addp]', el).forEach((s) => (s.onchange = () => {\n          sync();\n          const role = s.parentNode.dataset.picker === 'pilot' ? 'pilots' : 'managers';\n          if (s.value) crews[i][role].push(s.value);\n          drawCrews();\n        }));\n      });\n    };\n    drawCrews();\n    $('#add-crew', d).onclick = () => { sync(); crews.push({ name: '', pilots: [], managers: [] }); drawCrews(); };\n\n    $('#f', d).onsubmit = async (e) => {\n      e.preventDefault();\n      sync();\n      const v = formValues($('.grid', d));\n      const err = $('#err', d);\n      if (!v['ID']) return (err.textContent = 'Укажите ID.');\n      if (!v['Дата']) return (err.textContent = 'Укажите дату — без неё гонка не появится в приложении.');\n      const taken = groupEvents('События').concat(groupEvents('Архив событий')).some((x) => x.id === v['ID'] && (!g || x.id !== g.id));\n      if (taken) return (err.textContent = 'ID «' + v['ID'] + '» уже занят (в гонках или архиве). Придумайте другой.');\n      const baseObj = Object.assign({}, b, v, { 'Дата': fromIso(v['Дата']) });\n      delete baseObj['Состав'];\n      delete baseObj['Менеджер'];\n      delete baseObj['Пилоты'];\n      const list = crews.filter((c) => c.name || c.pilots.length || c.managers.length);\n      const crewObj = (c) => ({ 'Состав': c.name, 'Менеджер': c.managers.join(', '), 'Пилоты': c.pilots.join(', ') });\n      const rows = [Object.assign({}, baseObj, crewObj(list[0] || { name: '', pilots: [], managers: [] }))]\n        .concat(list.slice(1).map((c) => Object.assign({ 'ID': v['ID'] }, crewObj(c))));\n      $('#save', d).disabled = true;\n      const ok = await replace('События', g ? g.rows.map((x) => x.raw) : [], rows, 'Гонка сохранена');\n      if (!ok && $('#save', d)) $('#save', d).disabled = false;\n    };\n    const del = $('#del', d);\n    if (del) del.onclick = async () => {\n      if (await confirmBox('Удалить гонку «' + g.title + '» со всеми составами? Её траты пропадут из финансов.')) replace('События', g.rows.map((x) => x.raw), [], 'Гонка удалена');\n    };\n  }\n\n  // ---- Тренировки ----\n  function trainingsView() {\n    const sign = signups();\n    const list = byWhen(trainings('Тренировки')).filter((t) => match([t.id, t.title, t.obj['Тип'], t.obj['Трасса']].join(' ')));\n    return '<h1>Открытые тренировки</h1>' + toolbar('Тренировка', whenSeg()) + '<div class=\"list\">' + (list.map((t) => {\n      const going = sign.filter((s) => s.training === t.id);\n      return '<button class=\"item ' + (t.cancelled ? 'cancelled' : '') + '\" data-training=\"' + esc(t.id) + '\"><div class=\"main\"><div class=\"title\">' + esc(t.title) + '</div>' +\n        '<div class=\"meta\">' + esc([fmtDate(t.date), toTime(t.obj['Начало']), t.obj['Трасса'], t.obj['Стоимость заезда'] ? money(t.obj['Стоимость заезда']) + ' за заезд' : ''].filter(Boolean).join(' · ')) + '</div>' +\n        '<div class=\"badges\">' + (t.cancelled ? '<span class=\"badge off\">Отменено</span>' : '') + (t.obj['Тип'] ? '<span class=\"badge\">' + esc(t.obj['Тип']) + '</span>' : '') + '</div></div>' +\n        '<div class=\"side\">' + esc(t.id) + '<br>едут: ' + going.length + '</div></button>';\n    }).join('') || '<div class=\"empty\">Ничего не найдено</div>') + '</div>';\n  }\n\n  function editTraining(id) {\n    const t = id ? trainings('Тренировки').find((x) => x.id === id) : null;\n    const o = t ? t.obj : { 'Тип': 'Тренировочные заезды', 'Статус': 'Запланировано' };\n    const going = t ? signups().filter((s) => s.training === t.id) : [];\n    const d = openDrawer(\n      '<h2>' + (t ? esc(t.title) : 'Новая тренировка') + '<button class=\"btn ghost small x\" data-close>Закрыть</button></h2>' +\n      '<form id=\"f\"><div class=\"grid\">' +\n      field('ID *', input('ID', t ? t.id : '', 'required placeholder=\"Например, TR12\"')) +\n      field('Тип', select('Тип', o['Тип'] || '', ['Школа', 'Тренировочные заезды'])) +\n      field('Название', input('Название', o['Название'] || '', 'placeholder=\"Если пусто — по типу\"'), 'wide') +\n      field('Дата *', input('Дата', toIso(o['Дата']), 'type=\"date\" required')) +\n      field('Статус', select('Статус', o['Статус'] || '', ['Запланировано', 'Отменено'])) +\n      field('Начало', input('Начало', toTime(o['Начало']), 'type=\"time\"')) +\n      field('Окончание', input('Окончание', toTime(o['Окончание']), 'type=\"time\"')) +\n      field('Трасса', input('Трасса', o['Трасса'] || '', 'list=\"tracks\"') + datalist('tracks', tracks())) +\n      field('Адрес', input('Адрес', o['Адрес'] || '')) +\n      field('Стоимость заезда, ₽ *', input('Стоимость заезда', o['Стоимость заезда'] || '', 'required inputmode=\"decimal\"')) +\n      '<div></div>' +\n      field('Мин. заездов', input('Мин. заездов', o['Мин. заездов'] || '', 'type=\"number\" min=\"1\" max=\"30\" placeholder=\"1\"')) +\n      field('Макс. заездов', input('Макс. заездов', o['Макс. заездов'] || '', 'type=\"number\" min=\"1\" max=\"30\" placeholder=\"10\"')) +\n      field('Описание', '<textarea class=\"input\" name=\"Описание\">' + esc(o['Описание'] || '') + '</textarea>', 'wide') +\n      '</div>' +\n      (t ? '<div class=\"box\"><h3>Записались (' + going.length + ')</h3>' + (going.map((s, i) =>\n        '<div class=\"row-line\"><span class=\"grow\">' + esc(nameOf(s.obj['Пилот'])) + ' <span class=\"hint\">· ' + esc(s.obj['Заездов']) + ' заезд.</span></span><button type=\"button\" class=\"btn danger small\" data-unsign=\"' + i + '\">Убрать</button></div>').join('') || '<div class=\"hint\">Пока никто не отметился.</div>') + '</div>' : '') +\n      '<div class=\"err\" id=\"err\"></div>' +\n      '<div class=\"actions\">' + (t ? '<button type=\"button\" class=\"btn danger\" id=\"del\">Удалить</button>' : '') + '<div class=\"spacer\"></div><button type=\"button\" class=\"btn ghost\" data-close>Отмена</button><button class=\"btn\" id=\"save\">Сохранить</button></div></form>');\n    $$('[data-close]', d).forEach((x) => (x.onclick = closeDrawer));\n    $$('[data-unsign]', d).forEach((b) => (b.onclick = async () => {\n      const s = going[Number(b.dataset.unsign)];\n      if (await confirmBox('Убрать ' + nameOf(s.obj['Пилот']) + ' из записавшихся?', 'Убрать')) replace('Записи на тренировки', [s.raw], [], 'Запись убрана');\n    }));\n    $('#f', d).onsubmit = async (e) => {\n      e.preventDefault();\n      const v = formValues($('.grid', d));\n      const err = $('#err', d);\n      if (!v['ID'] || !v['Дата']) return (err.textContent = 'Укажите ID и дату.');\n      const min = Number(v['Мин. заездов'] || 1);\n      const max = Number(v['Макс. заездов'] || 10);\n      if (min > max) return (err.textContent = 'Минимум заездов больше максимума.');\n      const taken = trainings('Тренировки').concat(trainings('Архив тренировок')).some((x) => x.id === v['ID'] && (!t || x.id !== t.id));\n      if (taken) return (err.textContent = 'ID «' + v['ID'] + '» уже занят. Придумайте другой.');\n      $('#save', d).disabled = true;\n      const ok = await replace('Тренировки', t ? [t.raw] : [], [Object.assign({}, o, v, { 'Дата': fromIso(v['Дата']) })], 'Тренировка сохранена');\n      if (!ok && $('#save', d)) $('#save', d).disabled = false;\n    };\n    const del = $('#del', d);\n    if (del) del.onclick = async () => {\n      if (await confirmBox('Удалить тренировку «' + t.title + '»?')) replace('Тренировки', [t.raw], [], 'Тренировка удалена');\n    };\n  }\n\n  // ---- Люди ----\n  function peopleView() {\n    const list = people().map((p, i) => Object.assign(p, { i })).filter((p) => match([p.name, p.obj['Telegram'], p.obj['Telegram ID'], p.obj['Телефон']].join(' ')))\n      .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'ru'));\n    return '<h1>Люди</h1>' + toolbar('Человек') + '<div class=\"list\">' + (list.map((p) =>\n      '<button class=\"item\" data-person=\"' + p.i + '\" style=\"' + (p.active ? '' : 'opacity:.55') + '\"><div class=\"main\"><div class=\"title\">' + esc(p.name) + '</div>' +\n      '<div class=\"meta\">' + esc([p.obj['Telegram'] ? '@' + p.obj['Telegram'] : '', p.obj['Telegram ID'] ? 'ID ' + p.obj['Telegram ID'] : '', p.obj['Телефон']].filter(Boolean).join(' · ')) + '</div>' +\n      '<div class=\"badges\">' + (p.pilot ? '<span class=\"badge race\">Пилот</span>' : '') + (p.manager ? '<span class=\"badge\">Менеджер</span>' : '') + (p.lead ? '<span class=\"badge warn\">Руководство</span>' : '') + (p.active ? '' : '<span class=\"badge off\">Не активен</span>') + '</div></div></button>'\n    ).join('') || '<div class=\"empty\">Ничего не найдено</div>') + '</div>';\n  }\n\n  function editPerson(i) {\n    const p = i == null ? null : people()[i];\n    const o = p ? p.obj : { 'Пилот': 'Да', 'Активен': 'Да' };\n    const d = openDrawer(\n      '<h2>' + (p ? esc(p.name) : 'Новый человек') + '<button class=\"btn ghost small x\" data-close>Закрыть</button></h2>' +\n      '<form id=\"f\"><div class=\"grid\">' +\n      field('Имя *', input('Имя', o['Имя'] || '', 'required placeholder=\"Как показывать в приложении\"'), 'wide') +\n      field('Ник в Telegram', input('Telegram', o['Telegram'] || '', 'placeholder=\"без @\"')) +\n      field('Telegram ID', input('Telegram ID', o['Telegram ID'] || '', 'inputmode=\"numeric\" placeholder=\"если нет ника\"')) +\n      field('Телефон', input('Телефон', o['Телефон'] || '')) +\n      field('Ник в хронометраже', input('Ник в хронометраже', o['Ник в хронометраже'] || '', 'placeholder=\"как на timing.batyrshin.name\"')) +\n      '<div class=\"field wide\"><label>Роли</label><div class=\"checks\">' +\n      ['Пилот', 'Менеджер', 'Руководство'].map((r) => '<label class=\"check\"><input type=\"checkbox\" name=\"' + r + '\"' + (yes(o[r]) ? ' checked' : '') + '>' + r + '</label>').join('') +\n      '<label class=\"check\"><input type=\"checkbox\" name=\"Активен\"' + (String(o['Активен'] || '').trim().toLowerCase() !== 'нет' ? ' checked' : '') + '>Активен (есть доступ к приложению)</label></div></div>' +\n      '</div><div class=\"err\" id=\"err\"></div>' +\n      '<div class=\"actions\">' + (p ? '<button type=\"button\" class=\"btn danger\" id=\"del\">Удалить</button>' : '') + '<div class=\"spacer\"></div><button type=\"button\" class=\"btn ghost\" data-close>Отмена</button><button class=\"btn\" id=\"save\">Сохранить</button></div></form>');\n    $$('[data-close]', d).forEach((x) => (x.onclick = closeDrawer));\n    $('#f', d).onsubmit = async (e) => {\n      e.preventDefault();\n      const v = formValues($('.grid', d));\n      const err = $('#err', d);\n      v['Telegram'] = v['Telegram'].replace(/^@/, '').replace(/^https?:\\/\\/t\\.me\\//i, '');\n      if (!v['Telegram'] && !v['Telegram ID']) return (err.textContent = 'Укажите ник в Telegram или Telegram ID.');\n      if (v['Telegram ID'] && !/^\\d+$/.test(v['Telegram ID'])) return (err.textContent = 'Telegram ID — только цифры.');\n      const keys = [norm(v['Telegram']), norm(v['Telegram ID'])].filter(Boolean);\n      const dup = people().find((x, j) => j !== i && x.keys.some((k) => keys.indexOf(k) >= 0));\n      if (dup) return (err.textContent = 'Такой ник или ID уже есть у «' + dup.name + '».');\n      ['Пилот', 'Менеджер', 'Руководство', 'Активен'].forEach((r) => (v[r] = v[r] ? 'Да' : 'Нет'));\n      $('#save', d).disabled = true;\n      const ok = await replace('Люди', p ? [p.raw] : [], [Object.assign({}, o, v)], 'Сохранено');\n      if (!ok && $('#save', d)) $('#save', d).disabled = false;\n    };\n    const del = $('#del', d);\n    if (del) del.onclick = async () => {\n      if (await confirmBox('Удалить «' + p.name + '»? Чтобы просто закрыть доступ, лучше снять галочку «Активен».')) replace('Люди', [p.raw], [], 'Удалено');\n    };\n  }\n\n  // ---- Чемпионаты ----\n  function champsView() {\n    const list = objects('Чемпионаты').filter((x) => String(x.obj['Чемпионат'] || '').trim());\n    return '<h1>Чемпионаты</h1><div class=\"hint\" style=\"margin:-6px 0 14px\">Список для выбора в гонках. Переименование не меняет уже созданные гонки.</div>' +\n      toolbar('Чемпионат') + '<div class=\"list\">' + (list.map((x, i) => match(x.obj['Чемпионат']) ?\n      '<div class=\"item static\" data-ch=\"' + i + '\"><div class=\"main\"><input class=\"input\" style=\"width:100%\" value=\"' + esc(x.obj['Чемпионат']) + '\" data-ch-name></div>' +\n      '<button class=\"btn ghost small\" data-ch-save>Сохранить</button><button class=\"btn danger small\" data-ch-del>Удалить</button></div>' : '').join('') || '<div class=\"empty\">Пока пусто</div>') + '</div>';\n  }\n  function bindChamps() {\n    const list = objects('Чемпионаты').filter((x) => String(x.obj['Чемпионат'] || '').trim());\n    $$('[data-ch]').forEach((el) => {\n      const x = list[Number(el.dataset.ch)];\n      $('[data-ch-save]', el).onclick = () => {\n        const name = $('[data-ch-name]', el).value.trim();\n        if (name) replace('Чемпионаты', [x.raw], [Object.assign({}, x.obj, { 'Чемпионат': name })], 'Сохранено');\n      };\n      $('[data-ch-del]', el).onclick = async () => {\n        if (await confirmBox('Удалить «' + x.obj['Чемпионат'] + '» из списка?')) replace('Чемпионаты', [x.raw], [], 'Удалено');\n      };\n    });\n  }\n  function addChamp() {\n    const d = openDrawer('<h2>Новый чемпионат<button class=\"btn ghost small x\" data-close>Закрыть</button></h2><form id=\"f\">' +\n      field('Название *', input('Чемпионат', '', 'required autofocus')) + '<div class=\"err\" id=\"err\"></div>' +\n      '<div class=\"actions\"><div class=\"spacer\"></div><button type=\"button\" class=\"btn ghost\" data-close>Отмена</button><button class=\"btn\">Добавить</button></div></form>');\n    $$('[data-close]', d).forEach((x) => (x.onclick = closeDrawer));\n    $('#f', d).onsubmit = (e) => {\n      e.preventDefault();\n      const v = formValues(d);\n      if (championships().indexOf(v['Чемпионат']) >= 0) return ($('#err', d).textContent = 'Такой уже есть.');\n      replace('Чемпионаты', [], [v], 'Добавлено');\n    };\n  }\n\n  // ---- Заработок ----\n  function incomeView() {\n    const ev = new Map(groupEvents('События').concat(groupEvents('Архив событий')).map((g) => [g.id, g]));\n    const list = objects('Заработок').map((x, i) => Object.assign(x, { i })).filter((x) => match([nameOf(x.obj['Менеджер']), x.obj['ID гонки'], x.obj['Комментарий']].join(' ')));\n    list.sort((a, b) => (String(a.obj['Дата записи']) < String(b.obj['Дата записи']) ? 1 : -1));\n    return '<h1>Заработок менеджеров</h1><div class=\"hint\" style=\"margin:-6px 0 14px\">Менеджеры вносят суммы сами в приложении. Здесь можно убрать ошибочную запись.</div>' +\n      toolbar('') + '<div class=\"list\">' + (list.map((x) => {\n        const g = ev.get(String(x.obj['ID гонки'] || '').trim());\n        return '<div class=\"item static\"><div class=\"main\"><div class=\"title\">' + esc(nameOf(x.obj['Менеджер'])) + ' — ' + esc(money(x.obj['Сумма'])) + '</div>' +\n          '<div class=\"meta\">' + esc([g ? g.title : x.obj['ID гонки'], String(x.obj['Дата записи'] || '').slice(0, 10), x.obj['Комментарий']].filter(Boolean).join(' · ')) + '</div></div>' +\n          '<button class=\"btn danger small\" data-inc=\"' + x.i + '\">Удалить</button></div>';\n      }).join('') || '<div class=\"empty\">Записей нет</div>') + '</div>';\n  }\n  function bindIncome() {\n    const rows = objects('Заработок');\n    $$('[data-inc]').forEach((b) => (b.onclick = async () => {\n      const x = rows[Number(b.dataset.inc)];\n      if (await confirmBox('Удалить запись ' + nameOf(x.obj['Менеджер']) + ' на ' + money(x.obj['Сумма']) + '?')) replace('Заработок', [x.raw], [], 'Удалено');\n    }));\n  }\n\n  // ---- История ----\n  // Строки идут в порядке записи, поэтому новые — в конце листа.\n  function historyView() {\n    const all = objects('История действий').map((x) => x.obj).reverse();\n    const whoList = Array.from(new Set(all.map((h) => h['Кто']).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));\n    const kinds = Array.from(new Set(all.map((h) => h['Действие']).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));\n    const list = all.filter((h) => (!ui.who || h['Кто'] === ui.who) && (!ui.kind || h['Действие'] === ui.kind) &&\n      match([h['Кто'], h['Telegram'], h['Действие'], h['Подробности']].join(' ')));\n    const shown = list.slice(0, ui.historyLimit || 200);\n    const sel = (id, value, items, allLabel) => '<select class=\"input\" id=\"' + id + '\"><option value=\"\">' + allLabel + '</option>' +\n      items.map((x) => '<option' + (x === value ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select>';\n    return '<h1>История действий</h1><div class=\"hint\" style=\"margin:-6px 0 14px\">Кто и когда открывал приложение и что менял. Лист «История действий» в таблице очищается сам раз в 3 дня.</div>' +\n      toolbar('', sel('h-who', ui.who, whoList, 'Все люди') + sel('h-kind', ui.kind, kinds, 'Все действия')).replace('Поиск по названию', 'Поиск') +\n      '<div class=\"list\">' + (shown.map((h) =>\n        '<div class=\"item static\"><div class=\"main\"><div class=\"title\">' + esc(h['Действие']) + '</div>' +\n        (h['Подробности'] ? '<div class=\"meta\" style=\"white-space:normal\">' + esc(h['Подробности']) + '</div>' : '') + '</div>' +\n        '<div class=\"side\">' + esc(h['Время']) + '<br>' + esc(h['Кто']) + (h['Telegram'] ? ' · ' + esc(h['Telegram']) : '') + '</div></div>').join('') ||\n        '<div class=\"empty\">Пока пусто</div>') + '</div>' +\n      (list.length > shown.length ? '<div style=\"text-align:center;margin-top:12px\"><button class=\"btn ghost\" id=\"h-more\">Показать ещё (' + (list.length - shown.length) + ')</button></div>' : '');\n  }\n  function bindHistory() {\n    const who = $('#h-who');\n    const kind = $('#h-kind');\n    if (who) who.onchange = () => { ui.who = who.value; render(); };\n    if (kind) kind.onchange = () => { ui.kind = kind.value; render(); };\n    const more = $('#h-more');\n    if (more) more.onclick = () => { ui.historyLimit = (ui.historyLimit || 200) + 200; render(); };\n  }\n\n  // ---- Архив ----\n  function archiveView() {\n    const ev = groupEvents('Архив событий').filter((g) => match(g.id + ' ' + g.title));\n    const tr = trainings('Архив тренировок').filter((t) => match(t.id + ' ' + t.title));\n    const sort = (a, b) => (a.date < b.date ? 1 : -1);\n    const item = (x, kind) => '<div class=\"item static\"><div class=\"main\"><div class=\"title\">' + esc(x.title) + '</div><div class=\"meta\">' + esc(fmtDate(x.date)) + ' · ' + kind + ' · ' + esc(x.id) + '</div></div></div>';\n    return '<h1>Архив</h1><div class=\"hint\" style=\"margin:-6px 0 14px\">Сюда скрипт сам переносит гонки и тренировки, прошедшие больше недели назад. Они остаются в «Прошедших» и в финансах приложения.</div>' +\n      toolbar('') + '<div class=\"box\"><h3>Гонки (' + ev.length + ')</h3>' + (ev.sort(sort).map((g) => item(g, 'гонка')).join('') || '<div class=\"hint\">Пусто</div>') + '</div>' +\n      '<div class=\"box\"><h3>Тренировки (' + tr.length + ')</h3>' + (tr.sort(sort).map((t) => item(t, 'тренировка')).join('') || '<div class=\"hint\">Пусто</div>') + '</div>';\n  }\n\n  const LOGO_SRC = \"data:image/png;base64,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\";\n  // ---- Результаты тренировки ----\n  // Админ вставляет ссылки на заезды с timing.batyrshin.name, отмечает пилотов команды,\n  // панель рисует для каждого картинку с результатами, и бот присылает её пилоту.\n  // Этот кусок вставляется в admin.html при сборке и пользуется его общими функциями.\n  const TIMING_NICK = 'Ник в хронометраже';\n  const res = { links: '', title: '', heats: [], karts: {}, picked: {}, loading: false, sending: false };\n  const timeFmt = (s) => {\n    if (s == null || !isFinite(s)) return '—';\n    if (s < 60) return s.toFixed(3);\n    const m = Math.floor(s / 60);\n    return m + ':' + (s - m * 60).toFixed(3).padStart(6, '0');\n  };\n  const gapFmt = (d) => (d == null || !isFinite(d) ? '—' : Math.abs(d) < 0.0005 ? '0.000' : (d > 0 ? '+' : '−') + Math.abs(d).toFixed(3));\n\n  // Ники из хронометража у людей: колонка «Ник в хронометраже» (несколько — через запятую).\n  function timingNicks(p) {\n    return String(p.obj[TIMING_NICK] || '').split(/[,;\\n]+/).map((x) => fold(x.trim())).filter(Boolean);\n  }\n  function personForDriver(name) {\n    const n = fold(String(name || '').trim());\n    if (!n) return null;\n    const list = people().filter((p) => p.active);\n    return list.find((p) => timingNicks(p).indexOf(n) >= 0) ||\n      list.find((p) => fold(p.name) === n || p.keys.indexOf(n.replace(/^@/, '')) >= 0) || null;\n  }\n\n  // Запоминает, кто есть кто: дописывает имя из заезда в «Ник в хронометраже» человека.\n  async function linkDriver(name, key) {\n    const all = people();\n    // Сначала убрать это имя у того, к кому оно было привязано раньше.\n    const prev = all.find((p) => timingNicks(p).indexOf(fold(name)) >= 0);\n    if (prev && prev.key !== key) {\n      const left = String(prev.obj[TIMING_NICK] || '').split(/[,;\\n]+/).map((x) => x.trim()).filter((x) => x && fold(x) !== fold(name));\n      if (!(await replace('Люди', [prev.raw], [Object.assign({}, prev.obj, { [TIMING_NICK]: left.join(', ') })], 'Привязка снята'))) return;\n    }\n    if (!key) return render();\n    const p = people().find((x) => x.key === key);\n    if (!p) return;\n    const list = String(p.obj[TIMING_NICK] || '').split(/[,;\\n]+/).map((x) => x.trim()).filter(Boolean);\n    if (list.some((x) => fold(x) === fold(name))) return render();\n    list.push(name);\n    await replace('Люди', [p.raw], [Object.assign({}, p.obj, { [TIMING_NICK]: list.join(', ') })], '«' + name + '» — это ' + p.name);\n  }\n\n  // Тренировки для подписи на картинке: открытые и назначенные, свежие сверху.\n  function trainingTitles() {\n    const t = today();\n    const out = [];\n    trainings('Тренировки').concat(trainings('Архив тренировок')).forEach((x) => out.push({ date: x.date, title: x.title, track: x.obj['Трасса'] || '' }));\n    groupEvents('События').concat(groupEvents('Архив событий')).filter((g) => /трен/i.test(g.base['Тип'])).forEach((g) => out.push({ date: g.date, title: g.title, track: g.base['Трасса'] || '' }));\n    return out.filter((x) => x.date && x.date <= t).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 40);\n  }\n\n  function resultsView() {\n    const titles = trainingTitles();\n    const sel = '<select class=\"input\" id=\"r-title\" style=\"min-width:240px\"><option value=\"\">Подпись: только трасса и дата</option>' +\n      titles.map((x) => { const v = x.title + ' · ' + fmtDate(x.date); return '<option' + (v === res.title ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select>';\n    let html = '<h1>Результаты тренировки</h1>' +\n      '<div class=\"hint\" style=\"margin:-6px 0 14px\">Вставьте ссылки на заезды с timing.batyrshin.name, отметьте пилотов, и бот пришлёт каждому картинку с его результатами.</div>' +\n      '<div class=\"box\" style=\"margin-top:0\"><textarea class=\"input\" id=\"r-links\" placeholder=\"https://timing.batyrshin.name/tracks/drive/heats/123456&#10;по одной ссылке в строке\">' + esc(res.links) + '</textarea>' +\n      '<div class=\"bar\" style=\"margin:10px 0 0\">' + sel + '<div class=\"spacer\"></div><button class=\"btn\" id=\"r-load\"' + (res.loading ? ' disabled' : '') + '>' + (res.loading ? 'Загружаю…' : 'Загрузить заезды') + '</button></div></div>';\n    if (!res.heats.length) return html;\n    const team = people().filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name, 'ru'));\n    res.heats.forEach((h, hi) => {\n      html += '<div class=\"box\"><h3>Заезд ' + (hi + 1) + ' · ' + esc(h.name || '') + '<span style=\"text-transform:none;font-weight:500;letter-spacing:0\">' +\n        esc([h.track, fmtDate(h.date), h.time].filter(Boolean).join(' · ')) + '</span></h3>' +\n        '<div class=\"hint\" style=\"margin-bottom:6px\">Отметьте пилотов, которым отправить результаты. Если имя из заезда не узнано, выберите человека — панель запомнит.</div>';\n      h.drivers.forEach((d, di) => {\n        const p = personForDriver(d.name);\n        const id = hi + ':' + di;\n        html += '<div class=\"row-line\"><label class=\"check\" style=\"min-width:24px\"><input type=\"checkbox\" data-pick=\"' + id + '\"' + (res.picked[id] && p ? ' checked' : '') + (p ? '' : ' disabled') + '></label>' +\n          '<div style=\"width:34px;color:var(--hint)\">P' + d.pos + '</div>' +\n          '<div class=\"grow\"><b>' + esc(d.name) + '</b> <span class=\"hint\">карт ' + esc(d.kart) + ' · лучший ' + timeFmt(d.best) + '</span></div>' +\n          '<select class=\"input\" data-link=\"' + esc(d.name) + '\" style=\"max-width:220px\"><option value=\"\">не из команды</option>' +\n          team.map((t) => '<option value=\"' + esc(t.key) + '\"' + (p && p.key === t.key ? ' selected' : '') + '>' + esc(t.name) + '</option>').join('') + '</select></div>';\n      });\n      html += '</div>';\n    });\n    const n = picks().length;\n    html += '<div class=\"box\"><h3>Картинки' + (n ? ' (' + n + ')' : '') + '</h3><div id=\"r-previews\" class=\"previews\">' +\n      (n ? '' : '<div class=\"hint\">Отметьте хотя бы одного пилота.</div>') + '</div>' +\n      '<div class=\"err\" id=\"r-err\"></div><div class=\"bar\" style=\"margin:10px 0 0\"><div class=\"spacer\"></div>' +\n      '<label class=\"btn ghost small\" style=\"cursor:pointer\">' + (hasTeamFont() ? 'Шрифт команды выбран' : 'Шрифт команды (.otf)') + '<input type=\"file\" id=\"r-font\" accept=\".otf,.ttf,.woff,.woff2\" hidden></label>' +\n      '<button class=\"btn\" id=\"r-send\"' + (!n || res.sending ? ' disabled' : '') + '>' + (res.sending ? 'Отправляю…' : 'Отправить пилотам') + '</button></div></div>';\n    return html;\n  }\n\n  // Выбранные пары «заезд — пилот», у которых есть человек в «Людях».\n  function picks() {\n    const out = [];\n    res.heats.forEach((h, hi) => h.drivers.forEach((d, di) => {\n      const p = personForDriver(d.name);\n      if (res.picked[hi + ':' + di] && p) out.push({ heat: h, heatNo: hi + 1, driver: d, person: p });\n    }));\n    return out;\n  }\n\n  function bindResults() {\n    const links = $('#r-links');\n    if (!links) return;\n    links.oninput = () => (res.links = links.value);\n    $('#r-title').onchange = (e) => { res.title = e.target.value; drawPreviews(); };\n    $('#r-load').onclick = loadHeats;\n    $$('[data-pick]').forEach((b) => (b.onchange = () => { res.picked[b.dataset.pick] = b.checked; render(); }));\n    $$('[data-link]').forEach((s) => (s.onchange = () => linkDriver(s.dataset.link, s.value)));\n    const fontInput = $('#r-font');\n    if (fontInput) fontInput.onchange = () => {\n      const f = fontInput.files[0];\n      if (!f) return;\n      const rd = new FileReader();\n      rd.onload = () => {\n        try { localStorage.setItem(FONT_KEY, rd.result); } catch (e) { return toast('Не удалось сохранить шрифт в браузере', true); }\n        fontReady = null;\n        toast('Шрифт сохранён в этом браузере');\n        render();\n      };\n      rd.readAsDataURL(f);\n    };\n    const send = $('#r-send');\n    if (send) send.onclick = sendResults;\n    drawPreviews();\n  }\n\n  async function fetchTiming(url) {\n    const r = await call('admin_timing', url);\n    if (r && r.error) {\n      throw new Error(r.error === 'bad_url' ? 'Это не ссылка на заезд timing.batyrshin.name: ' + url : 'Сайт хронометража не ответил (' + r.error + ')');\n    }\n    return r;\n  }\n\n  async function loadHeats() {\n    const urls = res.links.split(/\\s+/).map((x) => x.trim()).filter(Boolean);\n    if (!urls.length) return toast('Вставьте хотя бы одну ссылку', true);\n    res.loading = true;\n    render();\n    const heats = [];\n    try {\n      for (const u of urls) {\n        const r = await fetchTiming(u);\n        const h = parseHeat(r.html, r.url);\n        if (!h.drivers.length) throw new Error('Не нашёл результатов на странице ' + u);\n        heats.push(h);\n      }\n      heats.sort((a, b) => ((a.date + a.time) < (b.date + b.time) ? -1 : 1));\n      res.heats = heats;\n      res.picked = {};\n      // Сразу отмечаем всех узнанных пилотов команды.\n      heats.forEach((h, hi) => h.drivers.forEach((d, di) => { if (personForDriver(d.name)) res.picked[hi + ':' + di] = true; }));\n    } catch (e) {\n      toast(e && e.message ? e.message : String(e), true);\n    }\n    res.loading = false;\n    render();\n  }\n\n  // ---- Разбор страниц timing.batyrshin.name ----\n  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };\n  const pad2 = (n) => String(n).padStart(2, '0');\n  // «37.322» или «1:09.311» → секунды.\n  function lapSec(t) {\n    const m = String(t || '').trim().match(/^(?:(\\d+):)?(\\d+(?:\\.\\d+)?)/);\n    return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : NaN;\n  }\n  const cleanText = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '');\n\n  // Страница заезда: таблица heat-result, столбцы — пилоты в порядке финиша.\n  function parseHeat(html, url) {\n    const doc = new DOMParser().parseFromString(html, 'text/html');\n    const m = String(url).match(/\\/tracks\\/([^/]+)\\/heats\\/(\\d+)/) || [];\n    const h = { url, track: m[1] || '', id: m[2] || '', name: cleanText(doc.querySelector('title')), date: '', time: '', drivers: [] };\n    const when = cleanText(doc.querySelector('h4 small')).match(/(\\d{1,2})\\s+([A-Za-z]{3})\\w*\\s+(\\d{4}),?\\s+(\\d{1,2}):(\\d{2})/);\n    if (when && MON[when[2].toLowerCase()]) {\n      h.date = when[3] + '-' + pad2(MON[when[2].toLowerCase()]) + '-' + pad2(when[1]);\n      h.time = pad2(when[4]) + ':' + when[5];\n    }\n    const table = doc.querySelector('table.heat-result');\n    if (!table) return h;\n    const rowBy = (label) => Array.prototype.find.call(table.querySelectorAll('tr'), (tr) => cleanText(tr.querySelector('th')) === label);\n    const cells = (tr) => (tr ? Array.prototype.slice.call(tr.children, 1) : []);\n    const names = cells(rowBy('Driver'));\n    const karts = cells(rowBy('Kart'));\n    const foot = (label) => cells(rowBy(label)).map((c) => cleanText(c));\n    const best = foot('Best');\n    const avg = foot('Avg');\n    const dev = foot('Dev');\n    const gap = foot('Gap');\n    names.forEach((th, i) => {\n      const a = th.querySelector('a');\n      h.drivers.push({\n        name: cleanText(th),\n        driverId: a ? (a.getAttribute('href').match(/drivers\\/(\\d+)/) || [])[1] || '' : '',\n        kart: cleanText(karts[i]),\n        pos: i + 1,\n        best: lapSec(best[i]), avg: lapSec(avg[i]), dev: lapSec(dev[i]), gap: gap[i] || '',\n        laps: [],\n      });\n    });\n    table.querySelectorAll('tbody tr').forEach((tr) => {\n      cells(tr).forEach((td, i) => {\n        // Время круга — текст ячейки до вложенных позиций и отрывов.\n        const own = Array.prototype.filter.call(td.childNodes, (n) => n.nodeType === 3).map((n) => n.textContent).join(' ');\n        const t = lapSec(own);\n        if (h.drivers[i] && isFinite(t)) h.drivers[i].laps.push(t);\n      });\n    });\n    h.drivers.forEach((d) => {\n      if (!isFinite(d.best) && d.laps.length) d.best = Math.min.apply(null, d.laps);\n    });\n    return h;\n  }\n\n  // Страница карта: лучшие круги этого карта в заездах (кто, когда, какой заезд).\n  function parseKart(html, heat) {\n    const doc = new DOMParser().parseFromString(html, 'text/html');\n    const year = Number((heat.date || '').slice(0, 4)) || new Date().getFullYear();\n    const hm = Number((heat.date || '').slice(5, 7)) || 12;\n    const rows = [];\n    doc.querySelectorAll('table tbody tr').forEach((tr) => {\n      const td = tr.querySelectorAll('td');\n      if (td.length < 4) return;\n      const heatLink = td[2].querySelector('a');\n      const w = cleanText(td[3]).match(/([A-Za-z]{3})\\w*\\s+(\\d{1,2}),?\\s+(\\d{1,2}):(\\d{2})/);\n      let date = '';\n      if (w && MON[w[1].toLowerCase()]) {\n        const mo = MON[w[1].toLowerCase()];\n        date = (mo - hm > 6 ? year - 1 : year) + '-' + pad2(mo) + '-' + pad2(w[2]);\n      }\n      rows.push({\n        best: lapSec(cleanText(td[0])),\n        driver: cleanText(td[1]),\n        heatId: heatLink ? (heatLink.getAttribute('href').match(/heats\\/(\\d+)/) || [])[1] || '' : '',\n        heatName: cleanText(td[2]),\n        date, time: w ? pad2(w[3]) + ':' + w[4] : '',\n      });\n    });\n    return { rows: rows.filter((r) => isFinite(r.best)) };\n  }\n\n  // История карта: страница карта на сайте. Загружается один раз на карт.\n  async function kartInfo(h, d) {\n    const key = h.track + '/' + d.kart;\n    if (!(key in res.karts)) {\n      res.karts[key] = null;\n      try {\n        // За 14 дней, чтобы найти заезды того же дня, даже если результаты отправляют позже.\n        const r = await fetchTiming(timingBase(h.url) + '/tracks/' + h.track + '/karts/' + encodeURIComponent(d.kart) + '?m=times&p=14d');\n        res.karts[key] = parseKart(r.html, h);\n      } catch (e) {\n        res.karts[key] = { rows: [], error: e && e.message ? e.message : String(e) };\n      }\n    }\n    return res.karts[key];\n  }\n  const timingBase = (url) => (String(url).match(/^https?:\\/\\/[^/]+/) || ['https://timing.batyrshin.name'])[0];\n\n  // Данные одной картинки: пилот, команда в заезде, карт под другими пилотами и отрывы.\n  function buildReport(pick, kart) {\n    const h = pick.heat;\n    const me = pick.driver;\n    const withBest = h.drivers.filter((d) => isFinite(d.best));\n    const heatBest = withBest.reduce((a, d) => (!a || d.best < a.best ? d : a), null);\n    const team = h.drivers.map((d) => ({ d, p: personForDriver(d.name) })).filter((x) => x.p).sort((a, b) => a.d.pos - b.d.pos);\n    // Карт под другими пилотами: в тот же день, а если таких заездов нет — за последние две недели.\n    const all = (kart && kart.rows ? kart.rows : []).filter((r) => r.heatId !== h.id && fold(r.driver) !== fold(me.name));\n    const sameDay = all.filter((r) => r.date === h.date);\n    const others = (sameDay.length ? sameDay : all).slice().sort((a, b) => a.best - b.best);\n    const kartBest = others.concat([{ driver: me.name, best: me.best, date: h.date }]).filter((r) => isFinite(r.best))\n      .reduce((a, r) => (!a || r.best < a.best ? r : a), null);\n    return {\n      title: res.title || [h.track, fmtDate(h.date)].filter(Boolean).join(' · '),\n      titled: !!res.title,\n      heatNo: pick.heatNo, heatName: h.name, date: h.date, time: h.time, track: h.track,\n      name: pick.person.name, driverName: me.name, pos: me.pos, total: h.drivers.length, kart: me.kart,\n      best: me.best, avg: me.avg, laps: me.laps ? me.laps.length : 0,\n      heatBest, kartBest,\n      team: team.map((x) => ({ name: x.p.name, me: x.d === me, pos: x.d.pos, kart: x.d.kart, best: x.d.best, avg: x.d.avg })),\n      kartRows: others.slice(0, 8),\n      kartPeriod: sameDay.length || !others.length ? 'в этот день' : 'за 2 недели',\n      kartError: kart && kart.error,\n    };\n  }\n\n  // ---- Картинка ----\n  const C = { bg: '#101011', card: '#1b1b1d', line: '#2a2a2d', hint: '#8d8d93', white: '#ffffff', orange: '#ff5a00' };\n  let logoImg = null;\n  function logo() {\n    if (logoImg) return Promise.resolve(logoImg);\n    return new Promise((resolve) => {\n      const img = new Image();\n      img.onload = () => resolve((logoImg = img));\n      img.onerror = () => resolve(null);\n      img.src = LOGO_SRC;\n    });\n  }\n  // Шрифт команды (Unifix SP) можно один раз выбрать на компьютере, он хранится в этом браузере.\n  const FONT_KEY = 'results_font';\n  let fontReady = null;\n  const hasTeamFont = () => { try { return !!localStorage.getItem(FONT_KEY); } catch (e) { return false; } };\n  function loadFont() {\n    if (fontReady) return fontReady;\n    fontReady = (async () => {\n      let data = '';\n      try { data = localStorage.getItem(FONT_KEY) || ''; } catch (e) {}\n      if (data && window.FontFace) {\n        try {\n          const f = new FontFace('TeamFont', 'url(' + data + ')');\n          await f.load();\n          document.fonts.add(f);\n          return 'TeamFont';\n        } catch (e) {}\n      }\n      try { await document.fonts.load('700 40px Unbounded'); await document.fonts.load('400 40px Unbounded'); } catch (e) {}\n      return 'Unbounded';\n    })();\n    return fontReady;\n  }\n\n  async function drawReport(r) {\n    const family = await loadFont();\n    const img = await logo();\n    const W = 1080;\n    const P = 56;\n    const rowH = 64;\n    const teamH = r.team.length ? 70 + r.team.length * rowH : 0;\n    const kartH = 70 + Math.max(1, r.kartRows.length) * rowH;\n    const H = 640 + 230 + teamH + 40 + kartH + 110;\n    const cv = document.createElement('canvas');\n    cv.width = W;\n    cv.height = H;\n    const g = cv.getContext('2d');\n    const font = (w, s) => (g.font = w + ' ' + s + 'px ' + family + ', \"Segoe UI\", sans-serif');\n    const text = (t, x, y, color, align) => { g.fillStyle = color; g.textAlign = align || 'left'; g.fillText(t, x, y); };\n    const fit = (t, max) => { let s = String(t); while (s.length > 1 && g.measureText(s).width > max) s = s.slice(0, -2) + '…'; return s; };\n    g.fillStyle = C.bg;\n    g.fillRect(0, 0, W, H);\n    g.textBaseline = 'alphabetic';\n\n    // Шапка, как на командных картинках: логотип, «results», заголовок с оранжевой точкой.\n    if (img) g.drawImage(img, P, 52, 290, 290 * img.height / img.width);\n    font(400, 46);\n    text('training', W - P, 100, '#9a9a9f', 'right');\n    font(400, 36);\n    text(fit(r.title.toLowerCase(), W - 2 * P), P, 200, C.white);\n    font(700, 112);\n    const head = 'заезд ' + r.heatNo;\n    text(head, P, 330, C.white);\n    const hw = g.measureText(head).width;\n    g.fillStyle = C.orange;\n    g.beginPath();\n    g.arc(P + hw + 22, 318, 13, 0, Math.PI * 2);\n    g.fill();\n    font(400, 28);\n    text(fit([r.titled ? r.track : '', r.time, r.heatName].filter(Boolean).join(' · ').toLowerCase(), W - 2 * P), P, 384, C.hint);\n\n    // Пилот: имя, позиция, карт, лучший круг.\n    let y = 430;\n    g.fillStyle = C.card;\n    roundRect(g, P, y, W - 2 * P, 180, 22);\n    font(700, 52);\n    text(fit(r.name.toLowerCase(), 600), P + 30, y + 72, C.white);\n    font(400, 26);\n    text('p' + r.pos + ' из ' + r.total + ' · карт ' + r.kart + (r.laps ? ' · кругов ' + r.laps : ''), P + 30, y + 118, C.hint);\n    if (isFinite(r.avg)) text('средний ' + timeFmt(r.avg), P + 30, y + 154, C.hint);\n    font(400, 24);\n    text('лучший круг', W - P - 30, y + 60, C.hint, 'right');\n    font(700, 64);\n    text(timeFmt(r.best), W - P - 30, y + 132, C.orange, 'right');\n\n    // Отрывы: от беста заезда и от беста карта.\n    y += 210;\n    const tile = (x, w, label, gap, sub) => {\n      g.fillStyle = C.card;\n      roundRect(g, x, y, w, 190, 22);\n      font(400, 24);\n      text(label, x + 26, y + 46, C.hint);\n      font(700, 56);\n      text(gapFmt(gap), x + 26, y + 120, gap > 0.0005 ? C.orange : C.white);\n      font(400, 22);\n      text(fit(sub, w - 52), x + 26, y + 162, C.hint);\n    };\n    const half = (W - 2 * P - 20) / 2;\n    tile(P, half, 'от беста заезда', r.heatBest ? r.best - r.heatBest.best : null,\n      r.heatBest ? (r.heatBest.name === r.driverName ? 'это ваш круг · ' : r.heatBest.name.toLowerCase() + ' · ') + timeFmt(r.heatBest.best) : '');\n    tile(P + half + 20, half, 'от беста карта', r.kartBest ? r.best - r.kartBest.best : null,\n      r.kartBest ? (r.kartBest.driver === r.driverName ? 'это ваш круг · ' : String(r.kartBest.driver).toLowerCase() + ' · ') + timeFmt(r.kartBest.best) : 'нет данных карта');\n    y += 230;\n\n    // Таблица: строки с позицией, именем, лучшим кругом и отрывом от пилота.\n    const table = (title, cols, rows) => {\n      font(400, 26);\n      text(title, P, y + 34, C.hint);\n      cols.forEach((c) => text(c.label, c.x, y + 34, C.hint, c.align));\n      y += 56;\n      rows.forEach((row) => {\n        g.fillStyle = C.line;\n        g.fillRect(0, y, W, 2);\n        if (row.me) {\n          g.fillStyle = C.card;\n          g.fillRect(0, y + 2, W, rowH - 2);\n          g.fillStyle = C.orange;\n          g.fillRect(0, y + 2, 8, rowH - 2);\n        }\n        row.cells.forEach((cell, i) => {\n          const c = cols[i];\n          font(cell.bold ? 700 : 400, 30);\n          text(fit(cell.t, c.w || 400), c.x, y + 44, cell.color || C.white, c.align);\n        });\n        y += rowH;\n      });\n    };\n    if (r.team.length) {\n      table('команда в заезде', [\n        { label: '', x: P, w: 80 }, { label: '', x: P + 90, w: 430 }, { label: 'карт', x: 640, align: 'right' },\n        { label: 'лучший', x: 840, align: 'right' }, { label: 'к вам', x: W - P, align: 'right' },\n      ], r.team.map((t) => ({\n        me: t.me,\n        cells: [\n          { t: 'p' + t.pos, bold: true }, { t: t.name.toLowerCase() + (t.me ? ' · вы' : '') }, { t: String(t.kart) },\n          { t: timeFmt(t.best) }, { t: t.me ? '' : gapFmt(r.best - t.best), color: r.best - t.best > 0.0005 ? C.orange : C.white },\n        ],\n      })));\n      y += 40;\n    }\n    const kartRows = r.kartRows.length ? r.kartRows.map((k) => ({\n      cells: [\n        { t: k.date ? k.date.split('-').reverse().slice(0, 2).join('.') : '' }, { t: String(k.driver || '').toLowerCase() },\n        { t: timeFmt(k.best) }, { t: gapFmt(r.best - k.best), color: r.best - k.best > 0.0005 ? C.orange : C.white },\n      ],\n    })) : [{ cells: [{ t: '' }, { t: r.kartError ? 'не удалось загрузить' : 'других заездов на этом карте нет', color: C.hint }, { t: '' }, { t: '' }] }];\n    table('карт ' + r.kart + ' у других · ' + r.kartPeriod, [\n      { label: '', x: P + 0, w: 110 }, { label: '', x: P + 130, w: 420 }, { label: 'лучший', x: 840, align: 'right' }, { label: 'к вам', x: W - P, align: 'right' },\n    ], kartRows);\n\n    font(400, 22);\n    text('timing.batyrshin.name', P, H - 44, '#5c5c61');\n    text('«+» — вы медленнее, «−» — быстрее', W - P, H - 44, '#5c5c61', 'right');\n    return cv;\n  }\n  function roundRect(g, x, y, w, h, r) {\n    g.beginPath();\n    g.moveTo(x + r, y);\n    g.arcTo(x + w, y, x + w, y + h, r);\n    g.arcTo(x + w, y + h, x, y + h, r);\n    g.arcTo(x, y + h, x, y, r);\n    g.arcTo(x, y, x + w, y, r);\n    g.closePath();\n    g.fill();\n  }\n\n  let drawSeq = 0;\n  async function drawPreviews() {\n    const box = $('#r-previews');\n    if (!box) return;\n    const list = picks();\n    if (!list.length) return;\n    const seq = ++drawSeq;\n    box.innerHTML = '<div class=\"hint\">Рисую картинки…</div>';\n    const out = [];\n    for (const p of list) {\n      const kart = await kartInfo(p.heat, p.driver);\n      const cv = await drawReport(buildReport(p, kart));\n      if (seq !== drawSeq) return;\n      out.push({ p, cv });\n    }\n    box.innerHTML = '';\n    out.forEach((x) => {\n      const fig = document.createElement('figure');\n      fig.innerHTML = '<figcaption>' + esc(x.p.person.name) + ' · заезд ' + x.p.heatNo + '</figcaption>';\n      x.cv.className = 'preview';\n      fig.appendChild(x.cv);\n      box.appendChild(fig);\n    });\n    res.rendered = out;\n  }\n\n  async function sendResults() {\n    const list = res.rendered || [];\n    if (!list.length) return;\n    const byPerson = new Map();\n    list.forEach((x) => {\n      if (!byPerson.has(x.p.person.key)) byPerson.set(x.p.person.key, { key: x.p.person.key, name: x.p.person.name, images: [] });\n      byPerson.get(x.p.person.key).images.push(x.cv.toDataURL('image/png'));\n    });\n    const items = Array.from(byPerson.values()).map((x) => ({\n      key: x.key, images: x.images,\n      caption: '🏁 Результаты тренировки' + (res.title ? ': ' + res.title : '') + (x.images.length > 1 ? ' (заездов: ' + x.images.length + ')' : ''),\n    }));\n    if (!(await confirmBox('Отправить картинки: ' + items.map((x) => byPerson.get(x.key).name + ' (' + x.images.length + ')').join(', ') + '?', 'Отправить'))) return;\n    res.sending = true;\n    render();\n    try {\n      const out = await call('admin_sendResults', items);\n      const bad = out.filter((x) => x.error);\n      const why = { no_chat: 'бот не знает его Telegram: пусть один раз откроет приложение', blocked: 'не нажал «Старт» в боте или заблокировал его', not_found: 'нет в «Людях»' };\n      if (bad.length) toast('Не отправлено: ' + bad.map((x) => (x.name || x.key) + ' — ' + (why[x.error] || x.error)).join('; '), true);\n      else toast('Отправлено: ' + out.length);\n    } catch (e) {\n      toast('Не удалось отправить: ' + (e && e.message ? e.message : e), true);\n    }\n    res.sending = false;\n    render();\n  }\n\n\n  $('#reload').onclick = () => { load(); toast('Обновлено'); };\n  load();\n})();\n</script>\n</body>\n</html>\n";
