
module.exports = async function handler(req, res) {
  const key = req.query.key || '';

  if (!key.startsWith('gsk_')) {
    return res.status(400).json({ error: 'pass ?key=gsk_...' });
  }

  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await r.json();
    res.status(r.status).json({ status: r.status, models: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
