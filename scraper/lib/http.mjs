// Shared HTTP helpers passed to scrapers as ctx.fetchText / ctx.fetchJson.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export async function fetchText(url, { timeoutMs = 20000, retries = 2, headers = {}, ...init } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': UA, 'Accept-Language': 'es-CO,es;q=0.9', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  return JSON.parse(text);
}

export function makeCtx({ log = console.log, now = new Date(), horizonDays = 75 } = {}) {
  return { fetchText, fetchJson, log, now, horizonDays };
}
