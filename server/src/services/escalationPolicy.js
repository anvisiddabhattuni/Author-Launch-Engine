import { config } from '../config.js';

/**
 * When work has to reach a human before it can be approved (STORY-008).
 *
 * One place, because there were three. The Content Drafting Agent, the PR and
 * Outreach Agent and the PR materials drafter each carried their own copy of
 * `confidence < threshold ? 'escalated' : 'pending_approval'`, which is three
 * chances for the rule to drift and no single answer to "what is the policy".
 *
 * Deliberately a pure function of stored numbers. That is what lets the Trust
 * and Monitoring Agent re-derive the same decision later from the row alone —
 * an independent check is only possible if the check does not need to be inside
 * the thing that produced the work.
 */

export const REASONS = {
  CONFIDENCE: 'confidence',
  THEME_ALIGNMENT: 'theme_alignment',
  VOICE: 'voice',
  BRAND_SAFETY: 'brand_safety',
};

/** Statuses a human is still able to act on, and so a monitor may still change. */
export const DECIDABLE = ['pending_approval', 'escalated'];

/**
 * @param {object} scores
 * @param {number} scores.confidence
 * @param {number|null} [scores.themeAlignment] Press materials and social posts.
 *   Kept a separate reason rather than blended into confidence, because
 *   REQ-003's acceptance criterion is specifically about theme alignment
 *   (STORY-003).
 * @param {number|null} [scores.voice] Social posts. Separate for the same
 *   reason: REQ-001 asks for a post that sounds like the author, so copy that
 *   argues the book's themes perfectly in a voice the author has never used
 *   must not pass on the strength of its themes (STORY-009).
 * @returns {{status: 'escalated'|'pending_approval', reasons: string[]}}
 */
export function assess({
  confidence,
  themeAlignment = null,
  voice = null,
  safetyFindings = [],
}) {
  const reasons = [];

  if (Number(confidence) < config.confidenceEscalationThreshold) {
    reasons.push(REASONS.CONFIDENCE);
  }
  if (themeAlignment !== null && Number(themeAlignment) < config.minThemeAlignment) {
    reasons.push(REASONS.THEME_ALIGNMENT);
  }
  if (voice !== null && Number(voice) < config.minVoiceMatch) {
    reasons.push(REASONS.VOICE);
  }
  // Brand safety is a judgement a person may overrule, so a finding escalates
  // rather than blocking (STORY-066). Image *rights* are not here on purpose:
  // they are a fact nobody at this company can overrule, and are enforced at
  // publication instead — the rule a superseded press kit follows.
  if (safetyFindings.length > 0) {
    reasons.push(REASONS.BRAND_SAFETY);
  }

  return {
    status: reasons.length > 0 ? 'escalated' : 'pending_approval',
    reasons,
  };
}

/** The thresholds in force, for anything that has to explain a decision. */
export const thresholds = () => ({
  confidence: config.confidenceEscalationThreshold,
  themeAlignment: config.minThemeAlignment,
  voice: config.minVoiceMatch,
});
