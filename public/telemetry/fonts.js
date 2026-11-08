// Шрифты для телеметрии: из Google Fonts и свои файлы (хранятся только в этом браузере).

// Шрифты с кириллицей идут первыми; у остальных русские подписи возьмутся из запасного шрифта.
export const GOOGLE_FONTS = [
  { name: 'Unbounded', cyr: true },
  { name: 'Onest', cyr: true },
  { name: 'Russo One', cyr: true },
  { name: 'Tektur', cyr: true },
  { name: 'Exo 2', cyr: true },
  { name: 'Oswald', cyr: true },
  { name: 'Rubik', cyr: true },
  { name: 'Manrope', cyr: true },
  { name: 'Montserrat', cyr: true },
  { name: 'Golos Text', cyr: true },
  { name: 'Play', cyr: true },
  { name: 'Jura', cyr: true },
  { name: 'Roboto Condensed', cyr: true },
  { name: 'Roboto Mono', cyr: true },
  { name: 'JetBrains Mono', cyr: true },
  { name: 'Orbitron', cyr: false },
  { name: 'Chakra Petch', cyr: false },
  { name: 'Bebas Neue', cyr: false },
  { name: 'Saira Condensed', cyr: false },
];

const loaded = new Map();
const SAMPLE = 'Круг 0123456789:.+−';

function addLink(href) {
  return new Promise((resolve, reject) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = () => resolve(l);
    l.onerror = () => { l.remove(); reject(new Error('font css')); };
    document.head.appendChild(l);
  });
}

// Подключает шрифт Google и ждёт, пока он будет готов для рисования на холсте.
export function loadGoogleFont(family) {
  family = String(family || '').trim();
  if (!family) return Promise.resolve(false);
  if (customNames.has(family)) return Promise.resolve(true);
  if (loaded.has(family)) return loaded.get(family);
  const base = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(family).replace(/%20/g, '+');
  // У одних шрифтов все начертания, у других одно — пробуем от полного набора к простому.
  const p = addLink(base + ':wght@400;500;600;700;800;900&display=swap')
    .catch(() => addLink(base + ':wght@400;700&display=swap'))
    .catch(() => addLink(base + '&display=swap'))
    .then(() => Promise.all([400, 500, 600, 700, 800, 900].map((w) => document.fonts.load(w + ' 40px "' + family + '"', SAMPLE).catch(() => null))))
    .then((r) => r.some((x) => x && x.length))
    .catch(() => false);
  loaded.set(family, p);
  p.then((ok) => { if (!ok) loaded.delete(family); });
  return p;
}

// ---- Свои шрифты в IndexedDB ----
const customNames = new Set();
function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('melvn-telemetry', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('fonts', { keyPath: 'name' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function register(name, buf) {
  const face = new FontFace(name, buf);
  await face.load();
  document.fonts.add(face);
  customNames.add(name);
}

export async function loadCustomFonts() {
  try {
    const d = await db();
    const all = await new Promise((resolve, reject) => {
      const q = d.transaction('fonts').objectStore('fonts').getAll();
      q.onsuccess = () => resolve(q.result || []);
      q.onerror = () => reject(q.error);
    });
    for (const f of all) {
      try { await register(f.name, f.buf); } catch (e) { /* битый файл пропускаем */ }
    }
  } catch (e) { /* в приватном окне хранилища может не быть */ }
  return [...customNames];
}

export async function addCustomFont(file) {
  const name = file.name.replace(/\.(otf|ttf|woff2?)$/i, '').replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim() || 'Мой шрифт';
  const buf = await file.arrayBuffer();
  await register(name, buf.slice(0));
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction('fonts', 'readwrite');
      tx.objectStore('fonts').put({ name, buf });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* шрифт всё равно работает до закрытия вкладки */ }
  return name;
}

export async function removeCustomFont(name) {
  customNames.delete(name);
  try {
    const d = await db();
    d.transaction('fonts', 'readwrite').objectStore('fonts').delete(name);
  } catch (e) { /* нечего удалять */ }
}

export const isCustomFont = (name) => customNames.has(name);
