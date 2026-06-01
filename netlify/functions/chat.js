// Netlify function for the "Uncle Heart" chat.
// Now includes two protections:
//   1. Per-message checks  -> blocks empty or oversized messages before calling the AI.
//   2. Per-person limit     -> stops one visitor sending too many messages per minute.

const { getStore } = require('@netlify/blobs');

// --- Settings you can adjust ---
const MAX_MESSAGE_LENGTH = 2000;   // longest a single message can be (characters)
const MAX_REQUESTS = 15;           // how many messages one person can send...
const WINDOW_SECONDS = 60;         // ...within this many seconds

exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const messages = body.messages || [];

    // ---------- Protection 1: per-message checks ----------
    const lastMessage = messages[messages.length - 1];
    const text = lastMessage && lastMessage.content ? String(lastMessage.content) : '';

    if (!text.trim()) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Empty message.' })
      };
    }

    if (text.length > MAX_MESSAGE_LENGTH) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Message is too long. Please shorten it.' })
      };
    }

    // ---------- Protection 2: per-person limit ----------
    // Work out who the visitor is (their IP address).
    const ip =
      (event.headers['x-nf-client-connection-ip']) ||
      (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      'unknown';

    const store = getStore('rate-limits');
    const now = Date.now();
    const windowMs = WINDOW_SECONDS * 1000;

    // Read this person's recent request times (if any).
    let timestamps = [];
    try {
      const existing = await store.get(ip, { type: 'json' });
      if (Array.isArray(existing)) timestamps = existing;
    } catch (e) {
      timestamps = []; // first time we've seen this person
    }

    // Keep only the requests made inside the current time window.
    timestamps = timestamps.filter((t) => now - t < windowMs);

    if (timestamps.length >= MAX_REQUESTS) {
      return {
        statusCode: 429, // "Too Many Requests"
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: [{ type: 'text', text: "You're sending messages a bit fast! Please wait a moment and try again. 😊" }]
        })
      };
    }

    // Record this request, then save the updated list.
    timestamps.push(now);
    await store.setJSON(ip, timestamps);

    // ---------- Call the AI (unchanged from before) ----------
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: body.system,
        messages: body.messages
      })
    });

    const data = await response.json();
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
