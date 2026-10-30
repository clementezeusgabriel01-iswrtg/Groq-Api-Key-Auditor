# Groq Key Auditor

A lightweight browser tool for auditing Groq API keys. Paste your keys, run the audit, and see which key–model combinations are active, rate-limited, or dead — with token and request usage pulled live from the API.

No server required. No dependencies. Unzip and open `index.html`.

---

## Files

```
groq-checker/
├── index.html   — markup and structure
├── style.css    — light theme, Inter + IBM Plex Mono
└── app.js       — all logic: key parsing, model discovery, concurrent testing
```

---

## Usage

1. Unzip `groq-checker.zip`
2. Open `index.html` in any modern browser
3. Paste your Groq API keys — one per line
4. Click **Run Audit**

Results stream in as they complete. The summary cards update when the audit finishes.

---

## What It Does

**Model discovery** — for each key, it hits `/v1/models` and pulls the list of available models, filtering out embedding and Whisper models.

**Concurrent testing** — runs up to 6 key–model tests in parallel using a bounded worker pool, same as the original Python script.

**Status detection**

| Status | Meaning |
| --- | --- |
| Active | Key works, got a 200 |
| Limited | Key works but rate-limited (429) |
| Error / HTTP N | Key is dead or rejected |

**Usage data** — req and token counts are read from the response body (`usage` object) and from rate-limit headers when the browser's CORS context exposes them. If neither is available, columns show `—` instead of a misleading `0`.

---

## CORS Note

Groq's API allows browser requests, so no proxy is needed. However, `x-ratelimit-remaining-*` headers are not always exposed to browser `fetch()` depending on the CORS preflight response. When they're unavailable, an info banner appears and columns show dashes. This is a Groq CORS config limitation, not a bug.

---

## Customizing

**Change concurrency** — edit `CONCURRENCY` at the top of `app.js` (default: 6)

**Filter models differently** — edit the `.filter()` in `getModels()` inside `app.js`

**Styling** — all design tokens are CSS variables at the top of `style.css`

---

## Requirements

- A modern browser (Chrome, Firefox, Safari, Edge — anything from 2021+)
- Valid Groq API keys starting with `gsk_`
