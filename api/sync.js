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
    // GET /api/sync?code=xxx  → 拉取数据
    if (req.method === 'GET') {
      const { code } = req.query;
      if (!code || code.length < 2) return res.status(400).json({ error: 'invalid code' });

      const d = await redis('POST', '', ['GET', `user:${code}`]);
      if (!d.result) return res.status(404).json({ error: 'not found' });

      const state = typeof d.result === 'string' ? JSON.parse(d.result) : d.result;
      return res.json({ state });
    }

    // POST /api/sync  body: { code, state, token? }  → 推送数据
    if (req.method === 'POST') {
      const { code, state, token } = req.body || {};
      if (!code || code.length < 2 || !state) return res.status(400).json({ error: 'invalid payload' });

      // 检查代号是否已存在
      const existing = await redis('POST', '', ['GET', `token:${code}`]);
      if (existing.result) {
        // 已存在：校验 token
        if (!token || token !== existing.result) {
          return res.status(409).json({ error: 'code_taken' });
        }
        // token 正确 → 允许更新，刷新 TTL
        await redis('POST', '/pipeline', [
          ['SET', `user:${code}`, JSON.stringify(state), 'EX', TTL],
          ['EXPIRE', `token:${code}`, TTL],
        ]);
        return res.json({ ok: true });
      }

      // 新代号：生成 token，写入数据和 token
      const newToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await redis('POST', '/pipeline', [
        ['SET', `user:${code}`,    JSON.stringify(state), 'EX', TTL],
        ['SET', `token:${code}`,   newToken,              'EX', TTL],
      ]);
      return res.json({ ok: true, token: newToken });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
