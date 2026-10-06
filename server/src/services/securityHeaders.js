/**
 * The browser-facing security policy (STORY-031 / REQ-008).
 *
 * One definition, three places that send it: the API (through helmet), the
 * Vite server that serves the UI in development and preview, and the nginx
 * config that serves it in a container. A policy written three times is three
 * policies, and the day they disagree the weakest one is the real one — so the
 * other two read this, and a test fails if nginx's copy drifts.
 *
 * The acceptance clause asks for `default-src 'self'`, and applied literally it
 * breaks the product: every meme preview is a `data:image/svg+xml` URI
 * (STORY-067's library stores its artwork that way), and `img-src` falls back
 * to `default-src`. The Review and Templates tabs would render empty frames.
 * So `default-src 'self'` stands and exactly one directive widens it, with the
 * reason beside it — the same declared-exemption shape as STORY-020's outbound
 * paths and STORY-024's unwalkable routes.
 *
 * No `'unsafe-inline'` for scripts or styles. React's `style={{…}}` props set
 * styles through the CSSOM, which CSP does not govern, so the forty-odd inline
 * style props in the client are not an exception — and the browser check in
 * `client/scripts/browserCheck.mjs` is what proves that, not this comment.
 */

/** Directive → sources. `default-src 'self'` is the acceptance clause, verbatim. */
export const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  // The one widening. Meme artwork is stored and served as data: URIs, and a
  // policy that blanks every meme is a policy somebody switches off.
  'img-src': ["'self'", 'data:'],
  // Nothing on this site is meant to be framed, and nothing may frame it.
  'frame-ancestors': ["'none'"],
  // A form that posts to another origin is how a stolen session leaves.
  'form-action': ["'self'"],
  // Stops an injected <base> from re-pointing every relative URL.
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
};

/** Why each widening exists. A directive not listed here is not a widening. */
export const CSP_EXEMPTIONS = {
  'img-src data:':
    'Meme template artwork and meme candidates are stored as data:image/svg+xml URIs (STORY-067). ' +
    'Without it every meme preview renders as an empty frame.',
};

/** The header value, in a stable order so every copy is byte-identical. */
export const cspHeader = (directives = CSP_DIRECTIVES) =>
  Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');

/** One year, the value HSTS preload lists require. */
export const HSTS_MAX_AGE = 31536000;

/**
 * Every header the UI should be served with, as a plain object — for Vite and
 * for the nginx drift test. The API gets the same values through helmet.
 *
 * `enforce: false` sends the CSP as Report-Only. That is for the Vite *dev*
 * server alone: React's fast-refresh injects an inline script, and a dev
 * server that refuses its own hot reload gets its policy deleted by the first
 * person it annoys. Violations still print in the console, so they are seen
 * during development rather than first discovered in production.
 */
export function uiHeaders({ enforce = true, https = false } = {}) {
  return {
    [enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only']: cspHeader(),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // From the first real ZAP scan (2026-09-30, rules 90004 and 10063): the
    // page's files are for this origin only, and the browser features the
    // product never uses are switched off rather than left to whoever embeds it.
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    // HSTS over plain http is ignored by browsers and misleading to a reader,
    // so it is only sent where the connection it describes is real.
    ...(https ? { 'Strict-Transport-Security': `max-age=${HSTS_MAX_AGE}; includeSubDomains` } : {}),
  };
}

/**
 * Paths that must answer over plain http even when HTTPS is enforced.
 *
 * A load balancer probes the instance directly on its private network, not
 * through the TLS terminator; redirecting the probe to https fails the probe
 * and takes a healthy instance out of rotation. They return no tenant data
 * (STORY-024 declares them unwalkable for the same reason).
 */
export const PLAIN_HTTP_ALLOWED = new Set(['/api/health', '/api/ready']);

/**
 * HTTPS enforcement, for an app that sits behind a TLS-terminating proxy.
 *
 * On by default in production and off in development, because localhost has
 * no certificate. Behind a proxy the app sees http and the proxy says
 * `X-Forwarded-Proto: https`; Express reads that only when `trust proxy` is
 * set, which `createApp` does exactly when this is enforced — trusting the
 * header without a proxy in front lets any client claim to be secure.
 *
 * A GET is redirected, because a person typing the URL should land somewhere.
 * Anything else is refused: redirecting a POST re-sends a body that already
 * crossed the network in the clear, and the damage is done by then.
 */
export function enforceHttps({ enabled }) {
  return (req, res, next) => {
    if (!enabled || req.secure || PLAIN_HTTP_ALLOWED.has(req.path)) return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
    }
    return res.status(403).json({
      error: 'HTTPS required. This request was sent over plain http and has not been processed.',
    });
  };
}
