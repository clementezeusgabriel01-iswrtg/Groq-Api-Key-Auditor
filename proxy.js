const GROQ_BASE = 'https://api.groq.com/openai/v1';

const EXPOSE = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'content-type',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Expose-Headers': EXPOSE.join(', '),
};

module.exports = async function handler(req, res) {
  // handle preflight
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  const path = req.query.path || '';
  const auth = req.headers['authorization'] || '';

  if (!auth.startsWith('Bearer gsk_')) {
    return res.status(400).json({ error: 'bad auth' });
  }

  try {
    const groqRes = await fetch(`${GROQ_BASE}${path}`, {
      method: req.method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      // body is already parsed by Vercel, re-stringify it
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });

    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

    // forward rate-limit headers
    for (const h of EXPOSE) {
      const val = groqRes.headers.get(h);
      if (val) res.setHeader(h, val);
    }

    const text = await groqRes.text();
    res.status(groqRes.status).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
