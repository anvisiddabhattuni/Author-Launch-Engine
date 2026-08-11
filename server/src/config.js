import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(here, '../../.env') });

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/author_launch_engine',
  port: number(process.env.PORT, 4000),
  aiProvider: process.env.AI_PROVIDER ?? 'stub',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
  confidenceEscalationThreshold: number(process.env.CONFIDENCE_ESCALATION_THRESHOLD, 0.7),
  minPostsPerWeek: number(process.env.MIN_POSTS_PER_WEEK, 3),
};

export const PLATFORMS = ['twitter', 'instagram', 'facebook', 'linkedin'];
