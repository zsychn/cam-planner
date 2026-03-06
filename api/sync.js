const TTL = 60 * 60 * 24 * 365; // 1年

async function redis(method, path, body) {
  const url   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET /api/sync?code=xxx  → 拉取用户数据
    if (req.method === 'GET') {
      const { code } = req.query;
      if (!code || code.length < 3) return res.status(400).json({ error: 'invalid code' });

      const d = await redis('POST', '', ['GET', `user:${code}`]);
      if (!d.result) return res.status(404).json({ error: 'not found' });

      const state = typeof d.result === 'string' ? JSON.parse(d.result) : d.result;
      return res.json({ state });
    }

    // POST /api/sync  body: { code, state }  → 推送用户数据
    if (req.method === 'POST') {
      const { code, state } = req.body || {};
      if (!code || code.length < 6 || !state) return res.status(400).json({ error: 'invalid payload' });

      await redis('POST', '/pipeline', [
        ['SET', `user:${code}`, JSON.stringify(state), 'EX', TTL],
      ]);
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
