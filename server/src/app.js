import cors from 'cors';
import express from 'express';

import { router } from './routes/index.js';

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

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', router);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // Errors carry a `status` when they represent a rejected business rule (a
  // closed approval gate, say) rather than a bug.
  app.use((error, _req, res, _next) => {
    const status = error.status ?? 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: errorMessage(error) });
  });

  return app;
}
