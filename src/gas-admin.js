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
