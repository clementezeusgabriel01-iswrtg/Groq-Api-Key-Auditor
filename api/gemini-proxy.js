const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  // handle preflight
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  const path = req.query.path || '';
  const apiKey = req.query.apiKey || '';

  if (!apiKey) {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: 'missing apiKey' });
  }

  const sep = path.includes('?') ? '&' : '?';

  try {
    const geminiRes = await fetch(`${GEMINI_BASE}${path}${sep}key=${encodeURIComponent(apiKey)}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      // body is already parsed by Vercel, re-stringify it
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });

    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

    const text = await geminiRes.text();
    res.status(geminiRes.status).send(text);
  } catch (err) {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    res.status(500).json({ error: err.message });
  }
};
