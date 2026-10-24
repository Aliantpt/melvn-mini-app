// Cloudflare Worker: отдаёт статику из public/ и API /api/me.
// Секреты (задаются в панели Cloudflare): BOT_TOKEN, SHEET_URL, SHEET_TOKEN.

import { buildView } from './logic.js';
import { verifyInitData } from './telegram.js';

const CACHE_SECONDS = 60;
let cached = null; // { at, data } — кэш таблицы внутри одного экземпляра воркера

async function loadSheet(env) {
  if (cached && Date.now() - cached.at < CACHE_SECONDS * 1000) return cached.data;
  const url = new URL(env.SHEET_URL);
  url.searchParams.set('token', env.SHEET_TOKEN);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Таблица ответила ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Таблица ответила: ${data.error}`);
  cached = { at: Date.now(), data };
  return data;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/me') {
      const user = await verifyInitData(request.headers.get('x-telegram-init-data'), env.BOT_TOKEN);
      if (!user) return json({ error: 'not_telegram' }, 401);
      try {
        const data = await loadSheet(env);
        return json(buildView(data, user, env.TIMEZONE || 'Europe/Moscow'));
      } catch (e) {
        return json({ error: 'sheet_unavailable', message: String(e.message || e) }, 502);
      }
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
