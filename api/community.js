const ROUTE_TTL = 60 * 60 * 24 * 90; // 90天
const FEED_KEYS = { route: 'routes:feed', member: 'members:feed' };
const nameKey = (type, name) => `${type}:name:${name.toLowerCase().trim()}`;

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

const parse = (raw) => typeof raw === 'string' ? JSON.parse(raw) : raw;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    // ── POST: 分享线路或队员（检查同名冲突）──────────────────
    if (req.method === 'POST') {
      const { name, sizes, type = 'route' } = req.body || {};
      if (!name || !sizes || !FEED_KEYS[type])
        return res.status(400).json({ error: 'invalid payload' });

      // 检查同名
      const existingId = await redisCmd('GET', nameKey(type, name));
      if (existingId) {
        const raw = await redisCmd('GET', `${type}:${existingId}`);
        if (raw) return res.status(409).json({ conflict: true });
        // key 过期则继续写入
      }

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const doc = { id, name, sizes, type, createdAt: Date.now() };

      await redisPipeline([
        ['SET', `${type}:${id}`, JSON.stringify(doc), 'EX', ROUTE_TTL],
        ['ZADD', FEED_KEYS[type], Date.now(), id],
        ['SET', nameKey(type, name), id, 'EX', ROUTE_TTL],
      ]);

      return res.json({ id });
    }

    // ── GET: 社区 feed（type=route|member）或单条──────────────
    if (req.method === 'GET') {
      const { id, type = 'route' } = req.query;
      if (!FEED_KEYS[type]) return res.status(400).json({ error: 'invalid type' });

      if (id) {
        const raw = await redisCmd('GET', `${type}:${id}`);
        if (!raw) return res.status(404).json({ error: 'Not found' });
        return res.json(parse(raw));
      }

      const ids = await redisCmd('ZREVRANGE', FEED_KEYS[type], 0, 49);
      if (!ids || !ids.length) return res.json([]);

      const pipeRes = await redisPipeline(ids.map(i => ['GET', `${type}:${i}`]));
      const docs = pipeRes.map(r => r.result).filter(Boolean).map(parse);

      return res.json(docs);
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
