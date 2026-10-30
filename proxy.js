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

module.exports = async function handler(req, res) {
  const path = req.query.path || '';
  const auth = req.headers['authorization'] || '';

  if (!auth.startsWith('Bearer gsk_')) {
    return res.status(400).json({ error: 'bad auth' });
  }

  const groqRes = await fetch(`${GROQ_BASE}${path}`, {
    method: req.method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
  });

  // expose rate-limit headers to the browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', EXPOSE.join(', '));

  for (const h of EXPOSE) {
    const val = groqRes.headers.get(h);
