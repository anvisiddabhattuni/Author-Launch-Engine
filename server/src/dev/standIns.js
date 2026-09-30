import http from 'node:http';

/**
 * Local stand-ins for Stripe and Twilio (STORY-036, STORY-037) — for the tests
 * and the demo only, never production.
 *
 * Each speaks the real service's HTTP API for the calls this system makes,
 * so the real adapters, the real gateway (timeouts, retries, circuit) and the
 * real error handling all run; only the far end is ours. Stripe's stand-in
 * understands Stripe's own test PaymentMethods (`pm_card_visa`,
 * `pm_card_chargeDeclinedInsufficientFunds`), which behave the same way in
 * Stripe's real test mode — so switching to a real `sk_test_` key changes the
 * far end and nothing else.
 *
 * Every request is kept in `received`; `failNext(n, status)` makes the next n
 * requests fail, to stand in for an outage.
 */
function standIn(handle) {
  const state = { received: [], failures: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const form = Object.fromEntries(new URLSearchParams(raw));
    state.received.push({ method: req.method, path: req.url, headers: req.headers, form });
    (state.rawBodies ??= []).push(raw);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const fail = state.failures.shift();
    if (fail) return send(fail, { error: { message: 'service temporarily unavailable (stand-in)' } });
    handle({ req, form, send, state });
  });
  return {
    state,
    get received() { return state.received; },
    failNext(n, status = 503) { for (let i = 0; i < n; i += 1) state.failures.push(status); },
    async start(port = 0) {
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    stop: () => new Promise((r) => server.close(r)),
  };
}

export function stripeStandIn() {
  let n = 0;
  const replays = new Map();
  return standIn(({ req, form, send, state }) => {
    if (!/^Bearer sk_(test|live)_/.test(req.headers.authorization ?? '')) {
      return send(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
    }
    const key = req.headers['idempotency-key'];
    if (key && replays.has(key)) {
      state.received[state.received.length - 1].replayed = true;
      const [status, body] = replays.get(key);
      return send(status, body);
    }
    const reply = (status, body) => { if (key) replays.set(key, [status, body]); send(status, body); };
    n += 1;
    if (req.url === '/v1/customers') return reply(200, { id: `cus_test_${n}`, object: 'customer', email: form.email });
    if (req.url === '/v1/payment_intents') {
      const id = `pi_test_${n}`;
      const base = { id, object: 'payment_intent', amount: Number(form.amount), currency: form.currency, customer: form.customer };
      if (form.payment_method === 'pm_card_visa') return reply(200, { ...base, status: 'succeeded' });
      const declines = {
        pm_card_chargeDeclinedInsufficientFunds: ['insufficient_funds', 'Your card has insufficient funds.'],
        pm_card_chargeDeclined: ['generic_decline', 'Your card was declined.'],
      };
      const d = declines[form.payment_method];
      if (d) {
        return reply(402, { error: { type: 'card_error', code: 'card_declined', decline_code: d[0], message: d[1], payment_intent: { ...base, status: 'requires_payment_method' } } });
      }
      return reply(400, { error: { type: 'invalid_request_error', message: `No such PaymentMethod: '${form.payment_method}'` } });
    }
    return send(404, { error: { message: `Unrecognized request URL (${req.url})` } });
  });
}

export function twilioStandIn() {
  let n = 0;
  return standIn(({ req, form, send }) => {
    const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    const match = req.url.match(/^\/2010-04-01\/Accounts\/([^/]+)\/Messages\.json$/);
    if (!match || !auth.startsWith(`${match[1]}:`)) return send(401, { code: 20003, message: 'Authenticate' });
    if (!/^\+[1-9]\d{7,14}$/.test(form.To ?? '')) return send(400, { code: 21211, message: `The 'To' number ${form.To} is not a valid phone number.` });
    n += 1;
    return send(201, { sid: `SM${String(n).padStart(32, '0')}`, status: 'queued', to: form.To, from: form.From, body: form.Body });
  });
}

/**
 * OpenAI's chat completions, for the demo (STORY-035). Answers with posts that
 * argue the first theme named in the prompt, so what comes back is scored
 * against the book like a real model's output would be.
 */
export function openaiStandIn() {
  let n = 0;
  return standIn(({ req, send, state }) => {
    if (!/^Bearer sk-/.test(req.headers.authorization ?? '')) return send(401, { error: { message: 'Incorrect API key provided' } });
    const body = JSON.parse(state.rawBodies?.at(-1) ?? '{}');
    n += 1;
    const prompt = (body.messages ?? []).map((m) => m.content).join('\n');
    const theme = prompt.match(/Theme "([^"]+)"/)?.[1] ?? prompt.match(/themes?:\s*([a-z ]+)/i)?.[1]?.trim() ?? 'craft';
    const count = Number(prompt.match(/Write exactly (\d+) posts/)?.[1] ?? 3);
    const platforms = prompt.match(/across these platforms: ([a-z, ]+)\./)?.[1]?.split(', ') ?? ['twitter'];
    const posts = Array.from({ length: count }, (_, i) => ({
      platform: platforms[i % platforms.length],
      content: `On ${theme}: the slow, quiet part of the work is the part that lasts. (${i + 1})`,
      themesUsed: [theme],
    }));
    return send(200, { id: `chatcmpl-standin-${n}`, model: 'gpt-standin', usage: { prompt_tokens: prompt.length, completion_tokens: 80 }, choices: [{ message: { role: 'assistant', content: JSON.stringify({ posts }) } }] });
  });
}
