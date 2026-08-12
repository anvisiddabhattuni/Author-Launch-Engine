import { config } from '../config.js';

import { anthropicProvider } from './anthropicProvider.js';
import { outreachAnthropicProvider } from './outreachAnthropicProvider.js';
import { outreachStubProvider } from './outreachStubProvider.js';
import { prAnthropicProvider } from './prAnthropicProvider.js';
import { prStubProvider } from './prStubProvider.js';
import { stubProvider } from './stubProvider.js';

const socialProviders = {
  stub: stubProvider,
  anthropic: anthropicProvider,
};

const outreachProviders = {
  stub: outreachStubProvider,
  anthropic: outreachAnthropicProvider,
};

const prProviders = {
  stub: prStubProvider,
  anthropic: prAnthropicProvider,
};

const resolve = (registry, name, kind) => {
  const provider = registry[name];
  if (!provider) {
    throw new Error(
      `Unknown AI_PROVIDER "${name}" for ${kind}. Available: ${Object.keys(registry).join(', ')}`,
    );
  }
  return provider;
};

/** Social post provider (STORY-001). */
export const getProvider = (name = config.aiProvider) =>
  resolve(socialProviders, name, 'social drafting');

/** Outreach email provider (STORY-002). */
export const getOutreachProvider = (name = config.aiProvider) =>
  resolve(outreachProviders, name, 'outreach drafting');

/** Press material provider (STORY-003). */
export const getPrProvider = (name = config.aiProvider) =>
  resolve(prProviders, name, 'press material drafting');
