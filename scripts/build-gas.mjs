// Собирает dist/Code.gs для Google Apps Script из src/logic.js и src/gas-main.js.
// Запуск: npm run build:gas
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const header = `// M-ELVN Mini App — код для Google Apps Script (Расширения → Apps Script).
// Файл собран автоматически из src/logic.js и src/gas-main.js, правьте исходники.
// Токен бота задаётся один раз: Настройки проекта → Свойства скрипта → BOT_TOKEN.

`;
const logic = read('src/logic.js').replace(/^export /gm, '');
const main = read('src/gas-main.js');

mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/Code.gs', root), header + main + '\n' + logic);
console.log('dist/Code.gs собран');
