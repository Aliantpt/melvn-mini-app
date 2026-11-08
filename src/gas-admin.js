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
