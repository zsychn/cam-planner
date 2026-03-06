const FEED_KEY = 'routes:feed';
const ROUTE_TTL = 60 * 60 * 24 * 90; // 90天

async function redisPipeline(cmds) {
  const url   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  return r.json();
}

async function redisCmd(...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const d = await r.json();
  return d.result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── POST: 分享一条线路 ──────────────────────────────────────
    if (req.method === 'POST') {
      const { name, sizes } = req.body || {};
      if (!name || !sizes) return res.status(400).json({ error: 'name & sizes required' });

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const route = { id, name, sizes, createdAt: Date.now() };

      await redisPipeline([
        ['SET', `route:${id}`, JSON.stringify(route), 'EX', ROUTE_TTL],
        ['ZADD', FEED_KEY, Date.now(), id],
      ]);

      return res.json({ id });
    }

    // ── GET: 拉取社区线路 ────────────────────────────────────────
    if (req.method === 'GET') {
      const { id } = req.query;

      // 单条
      if (id) {
        const raw = await redisCmd('GET', `route:${id}`);
        if (!raw) return res.status(404).json({ error: 'Not found' });
        return res.json(typeof raw === 'string' ? JSON.parse(raw) : raw);
      }

      // Feed（最新 50 条）
      const ids = await redisCmd('ZREVRANGE', FEED_KEY, 0, 49);
      if (!ids || !ids.length) return res.json([]);

      const pipeRes = await redisPipeline(ids.map(i => ['GET', `route:${i}`]));
      const routes = pipeRes
        .map(r => r.result)
        .filter(Boolean)
        .map(r => (typeof r === 'string' ? JSON.parse(r) : r));

      return res.json(routes);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
