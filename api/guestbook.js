// 방명록 API (Vercel Serverless Function)
// 저장소: Upstash Redis (Vercel Storage에서 프로젝트에 연결하면 환경 변수가 자동으로 들어옵니다)
//   GET  /api/guestbook  → 최근 방명록 목록
//   POST /api/guestbook  → { name, message } 새 글 작성

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LIST_KEY = 'guestbook';
const MAX_KEEP = 500;      // 보관할 최대 글 수
const MAX_SHOW = 100;      // 한 번에 보여줄 글 수
const NAME_MAX = 20;
const MESSAGE_MAX = 300;
const COOLDOWN_SEC = 20;   // 같은 사람이 연속으로 글을 쓸 수 있는 간격

async function redis(commands) {
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const out = await r.json();
  return out.map((x) => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}

function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: 'not_configured', message: '방명록 저장소가 아직 연결되지 않았어요.' });
  }

  try {
    if (req.method === 'GET') {
      const [items] = await redis([['LRANGE', LIST_KEY, '0', String(MAX_SHOW - 1)]]);
      const entries = (items || []).map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      }).filter(Boolean);
      return res.status(200).json({ entries });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};

      if (body.website) return res.status(200).json({ ok: true }); // 스팸봇용 숨은 칸

      const name = clean(body.name, NAME_MAX);
      const message = clean(body.message, MESSAGE_MAX);
      if (!name) return res.status(400).json({ error: 'name', message: '닉네임을 입력해 주세요.' });
      if (!message) return res.status(400).json({ error: 'message', message: '내용을 입력해 주세요.' });

      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const [allowed] = await redis([['SET', 'gb:cool:' + ip, '1', 'EX', String(COOLDOWN_SEC), 'NX']]);
      if (allowed !== 'OK') {
        return res.status(429).json({ error: 'slow_down', message: '잠시 후에 다시 남겨 주세요.' });
      }

      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        name,
        message,
        createdAt: new Date().toISOString(),
      };
      await redis([
        ['LPUSH', LIST_KEY, JSON.stringify(entry)],
        ['LTRIM', LIST_KEY, '0', String(MAX_KEEP - 1)],
      ]);
      return res.status(201).json({ entry });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server', message: '잠시 문제가 생겼어요. 다시 시도해 주세요.' });
  }
};
