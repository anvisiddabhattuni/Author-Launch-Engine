import cors from 'cors';
import express from 'express';

import { router } from './routes/index.js';

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
    res.status(status).json({ error: error.message });
  });

  return app;
}
