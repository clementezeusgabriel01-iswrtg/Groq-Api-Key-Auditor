// Vercel Edge Function — proxies Groq requests so rate-limit headers reach the browser
export const config = { runtime: 'edge' };

const GROQ_BASE = 'https://api.groq.com/openai/v1';

// headers we want to forward back to the browser
const EXPOSE = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'content-type',
];

export default async function handler(req) {
  // path comes in as ?path=/models or ?path=/chat/completions
  const url   = new URL(req.url);
  const path  = url.searchParams.get('path') || '';
  const auth  = req.headers.get('authorization') || '';

  if (!auth.startsWith('Bearer gsk_')) {
    return new Response(JSON.stringify({ error: 'Missing or invalid Authorization header' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // forward the request to Groq
  const groqRes = await fetch(`${GROQ_BASE}${path}`, {
    method:  req.method,
    headers: {
      'Authorization': auth,
      'Content-Type':  'application/json',
    },
    body: req.method !== 'GET' ? req.body : undefined,
  });

  // build response headers — expose rate-limit ones to the browser
  const resHeaders = new Headers({
    'Access-Control-Allow-Origin':   '*',
    'Access-Control-Expose-Headers': EXPOSE.join(', '),
  });

  for (const h of EXPOSE) {
    const val = groqRes.headers.get(h);
    if (val) resHeaders.set(h, val);
  }

  return new Response(groqRes.body, {
    status:  groqRes.status,
    headers: resHeaders,
  });
}
