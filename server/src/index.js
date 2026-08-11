import { createApp } from './app.js';
import { config } from './config.js';

createApp().listen(config.port, () => {
  console.log(`Author Launch Engine API on http://localhost:${config.port}`);
  console.log(`content provider: ${config.aiProvider}`);
});
