const FEED_KEY  = 'routes:feed';
const ROUTE_TTL = 60 * 60 * 24 * 90; // 90天

const nameKey = (name) => `route:name:${name.toLowerCase().trim()}`;

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

function parseRoute(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    // ── POST: 分享线路（检查同名冲突）─────────────────────────
    if (req.method === 'POST') {
      const { name, sizes } = req.body || {};
      if (!name || !sizes) return res.status(400).json({ error: 'name & sizes required' });

      // 检查同名
      const existingId = await redisCmd('GET', nameKey(name));
      if (existingId) {
        const raw = await redisCmd('GET', `route:${existingId}`);
        if (raw) {
          return res.status(409).json({ conflict: true, existing: parseRoute(raw) });
        }
        // 旧 id 已过期，继续正常写入
      }

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const route = { id, name, sizes, createdAt: Date.now() };

      await redisPipeline([
        ['SET', `route:${id}`, JSON.stringify(route), 'EX', ROUTE_TTL],
        ['ZADD', FEED_KEY, Date.now(), id],
        ['SET', nameKey(name), id, 'EX', ROUTE_TTL],
      ]);

      return res.json({ id });
    }

    // ── PUT: 合并同名线路（取各号最大值）─────────────────────
    if (req.method === 'PUT') {
      const { id, sizes } = req.body || {};
      if (!id || !sizes) return res.status(400).json({ error: 'id & sizes required' });

      const raw = await redisCmd('GET', `route:${id}`);
      if (!raw) return res.status(404).json({ error: 'Not found' });

      const existing = parseRoute(raw);
      const merged = { ...existing.sizes };
      Object.entries(sizes).forEach(([sid, cnt]) => {
        merged[sid] = Math.max(merged[sid] || 0, cnt);
      });
      existing.sizes = merged;
      existing.updatedAt = Date.now();

      await redisCmd('SET', `route:${id}`, JSON.stringify(existing), 'EX', ROUTE_TTL);
      return res.json({ id });
    }

    // ── GET: 社区 feed 或单条─────────────────────────────────
    if (req.method === 'GET') {
      const { id } = req.query;

      if (id) {
        const raw = await redisCmd('GET', `route:${id}`);
        if (!raw) return res.status(404).json({ error: 'Not found' });
        return res.json(parseRoute(raw));
      }

      const ids = await redisCmd('ZREVRANGE', FEED_KEY, 0, 49);
      if (!ids || !ids.length) return res.json([]);

      const pipeRes = await redisPipeline(ids.map(i => ['GET', `route:${i}`]));
      const routes = pipeRes
        .map(r => r.result)
        .filter(Boolean)
        .map(parseRoute);

      return res.json(routes);
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
