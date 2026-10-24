// Код для Google Apps Script, привязанного к таблице M-ELVN.
// Отдаёт листы «Люди», «События», «Составы» в виде JSON по секретному токену.
// Строка 1 — заголовки, строка 2 — подсказки (пропускается), данные с 3-й строки.

const TOKEN = 'ВСТАВЬТЕ_ТОКЕН';
const SHEETS = ['Люди', 'События', 'Составы'];

function doGet(e) {
  if (!e || !e.parameter || e.parameter.token !== TOKEN) {
    return json({ error: 'forbidden' });
  }
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
  return json(out);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
