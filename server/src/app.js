import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { config } from './config.js';
import { router } from './routes/index.js';
import { accessLog } from './services/dataAccess.js';
import { observeRequests } from './services/requestStats.js';
import { CSP_DIRECTIVES, HSTS_MAX_AGE, enforceHttps } from './services/securityHeaders.js';

/**
 * Guarantees a response carries something a human can read.
 *
 * Not every thrown error has a message. A dropped database connection arrives as
 * an `AggregateError` whose `message` is the empty string, which used to be sent
 * verbatim — and an empty message renders as no message at all, so the UI showed
 * nothing and the failure looked like the button simply not working.
 *
 * The full error still goes to the server log; this only ensures the *response*
 * says something. Silence is the one thing a failure must not be.
 */
export const errorMessage = (error) =>
  (typeof error?.message === 'string' ? error.message.trim() : '') ||
  error?.code ||
  error?.name ||
  'Internal server error';

export function createApp({ httpsRequired = config.enforceHttps, corsOrigins = config.corsOrigins } = {}) {
  const app = express();

  // Only behind a proxy do we believe X-Forwarded-Proto. Trusting it with
  // nothing in front lets any client declare its own connection secure.
  if (httpsRequired) app.set('trust proxy', 1);

  // STORY-031. Before everything, including the request counter: a plain-http
  // request refused here should not be served, and it is still counted.
  app.use(observeRequests());
  app.use(enforceHttps({ enabled: httpsRequired }));
  app.use(
    helmet({
      // The shared policy, not helmet's defaults — helmet's own CSP allows
      // inline styles, and three copies of the policy is three policies.
      contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
      // Sent only where the connection is actually https (see uiHeaders).
      strictTransportSecurity: httpsRequired ? { maxAge: HSTS_MAX_AGE, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
    }),
  );
  // Was `cors()` — every origin on the internet. The UI is same-origin, so the
  // list is empty in production and holds the Vite port in development.
  app.use(cors({ origin: corsOrigins.length ? corsOrigins : false }));
  // The counter above runs first, so a request that fails in the JSON parser
  // is still counted. An error rate that excludes the errors is not an error
  // rate (STORY-027).
  app.use(express.json({ limit: '5mb' }));
  // STORY-044: every request that reaches tenant data, recorded when it ends.
  app.use('/api', accessLog());
  app.use('/api', router);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // Errors carry a `status` when they represent a rejected business rule (a
  // closed approval gate, say) rather than a bug.
  app.use((error, _req, res, _next) => {
    const status = error.status ?? 500;
    if (status >= 500) console.error(error);
    // The reason, for the access log (STORY-044): a refusal recorded without
    // why is half a record.
    // A refusal may carry a fuller reason than it tells the caller — an API
    // key's "revoked" versus "unknown" is for the security officer only.
    res.locals.accessReason = error.accessReason ?? errorMessage(error);
    // `details` is set by input validation (STORY-032): one entry per field,
    // so a client can point at the box that is wrong rather than parse prose.
    res.status(status).json(error.details ? { error: errorMessage(error), details: error.details } : { error: errorMessage(error) });
  });

  return app;
}
