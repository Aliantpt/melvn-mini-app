// Собирает dist/Code.gs для Google Apps Script из src/logic.js и src/gas-main.js.
// Запуск: npm run build:gas
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const header = `// M-ELVN Mini App — код для Google Apps Script (Расширения → Apps Script).
// Файл собран автоматически из src/logic.js, src/gas-main.js, src/gas-admin.js и admin/, правьте исходники.
// Токен бота задаётся один раз: Настройки проекта → Свойства скрипта → BOT_TOKEN.

`;
const logic = read('src/logic.js').replace(/^export /gm, '');
const main = read('src/gas-main.js');
const admin = read('src/gas-admin.js');
// Страница админ-панели вшивается строкой, чтобы в Apps Script был один файл.
// Вкладка «Результаты» (admin/results.js) и логотип вставляются в страницу здесь.
const logo = 'data:image/png;base64,' + readFileSync(new URL('admin/logo.png', root)).toString('base64');
const page = read('admin/admin.html').replace('/*@RESULTS_JS@*/', () => `  const LOGO_SRC = ${JSON.stringify(logo)};\n` + read('admin/results.js'));
const adminHtml = `\n// Страница админ-панели (из admin/admin.html и admin/results.js).\nconst ADMIN_HTML = ${JSON.stringify(page)};\n`;

mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/Code.gs', root), header + main + '\n' + admin + '\n' + logic + adminHtml);
console.log('dist/Code.gs собран');
