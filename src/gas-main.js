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
const ASSIGN_SHEET = 'Журнал назначений';
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
    // Через кэш: заодно таймер каждые 5 минут держит кэш тёплым для приложения.
    const data = readSheetsCached();
    const log = ensureSheet(LOG_SHEET, ['Ключ', 'Отправлено'], ['Служебный лист: какие напоминания уже отправлены', '']);
    const logged = log.getDataRange().getDisplayValues();
    const sent = new Set(logged.slice(2).map(function (r) { return r[0]; }));
    const due = dueReminders(data, Date.now(), sent).slice(0, MAX_SENDS_PER_RUN);
    let stopped = false;
    for (let i = 0; i < due.length; i++) {
      const r = due[i];
      const code = sendBot_(token, r.chatId, r.text);
      // В журнал — только то, что отправлено, или то, что повторять бесполезно:
      // 400 — чат не найден, 403 — человек запретил боту писать.
      if (code === 200 || code === 400 || code === 403) {
        if (code !== 200) console.error('sendMessage ' + code + ' для ' + r.key + ', больше не пробуем');
        log.appendRow([safeCell(r.key), new Date().toISOString()]);
      } else {
        // 429 (слишком часто), 5xx и обрывы связи: не записываем — через 5 минут отправим снова,
        // пока событие не началось.
        console.error('sendMessage ' + code + ' для ' + r.key + ', повторим через 5 минут');
        if (code === 429) { stopped = true; break; }
      }
    }
    if (due.length) logAction_(null, null, 'Бот отправил напоминания', 'Сообщений: ' + due.length);
    if (!stopped) notifyAssignments_(data, token, MAX_SENDS_PER_RUN - due.length);
    // Журнал не растёт бесконечно: старые записи удаляются.
    if (logged.length > 3000) log.deleteRows(3, logged.length - 2000);
  } finally {
    lock.releaseLock();
  }
}

// Сообщение от бота с кнопкой приложения. Возвращает код ответа Telegram (0 — нет связи).
function sendBot_(token, chatId, text) {
  try {
    return UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: APP_URL } }]] },
      }),
    }).getResponseCode();
  } catch (err) {
    // Сеть или Telegram не ответили — попробуем на следующем запуске.
    console.error(err);
    return 0;
  }
}

// Новые назначения на гонки: бот пишет пилоту или менеджеру, на какую роль, в какую гонку и когда.
// О каких назначениях уже сообщили — на служебном листе «Журнал назначений». Если человека
// убрали из состава, запись удаляется, и при новом назначении он снова получит сообщение.
function notifyAssignments_(data, token, budget) {
  const sh = ensureSheet(ASSIGN_SHEET, ['Ключ', 'Отправлено'], ['Служебный лист: о каких назначениях бот уже сообщил', '']);
  const logged = sh.getDataRange().getDisplayValues().slice(2).filter(function (r) { return r[0]; });
  const notified = new Set(logged.map(function (r) { return r[0]; }));
  const current = currentAssignments(data, Date.now(), chatIds_());
  const props = PropertiesService.getScriptProperties();
  const now = new Date().toISOString();
  // Первый запуск: всё, что уже назначено, считаем известным, чтобы не написать всем сразу.
  if (!props.getProperty('assign_seeded')) {
    const rows = [];
    current.forEach(function (a) { a.keys.forEach(function (k) { if (!notified.has(k)) rows.push([safeCell(k), now]); }); });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
    props.setProperty('assign_seeded', '1');
    return;
  }
  // Убираем записи о назначениях, которых больше нет (сняли с гонки или гонка прошла).
  const live = new Set();
  current.forEach(function (a) { a.keys.forEach(function (k) { live.add(k); }); });
  const keep = logged.filter(function (r) { return live.has(r[0]); });
  if (keep.length < logged.length) {
    const last = sh.getLastRow();
    if (last > 2) sh.getRange(3, 1, last - 2, 2).clearContent();
    if (keep.length) sh.getRange(3, 1, keep.length, 2).setValues(keep.map(function (r) { return [safeCell(r[0]), r[1]]; }));
    notified.clear();
    keep.forEach(function (r) { notified.add(r[0]); });
  }
  const due = newAssignments(current, notified).slice(0, Math.max(0, budget));
  const sentTo = [];
  for (let i = 0; i < due.length; i++) {
    const code = sendBot_(token, due[i].chatId, due[i].text);
    // 400/403 — писать некуда или человек запретил боту: повторять бесполезно.
    if (code === 200 || code === 400 || code === 403) {
      due[i].keys.forEach(function (k) { sh.appendRow([safeCell(k), now]); });
      if (code === 200) sentTo.push(due[i].who + ' — ' + due[i].title);
    } else {
      console.error('sendMessage ' + code + ' (назначение), повторим через 5 минут');
      if (code === 429) break;
    }
  }
  if (sentTo.length) logAction_(null, null, 'Бот сообщил о назначениях', sentTo.join('; ').slice(0, 450));
}

// Telegram ID людей, открывавших приложение: нужны, чтобы писать тем, у кого в «Людях» только ник.
function chatIds_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty('chat_ids') || '{}');
  } catch (err) {
    return {};
  }
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
