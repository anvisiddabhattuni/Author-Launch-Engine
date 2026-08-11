import { config } from '../config.js';

import { anthropicProvider } from './anthropicProvider.js';
import { stubProvider } from './stubProvider.js';

const providers = {
  stub: stubProvider,
  anthropic: anthropicProvider,
};

export function getProvider(name = config.aiProvider) {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown AI_PROVIDER "${name}". Available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}
