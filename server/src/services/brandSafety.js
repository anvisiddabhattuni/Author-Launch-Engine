/**
 * Brand-safety and image-rights checks for meme candidates (STORY-066).
 *
 * The story's third clause: a candidate failing either check is "withheld and
 * routed to a human instead of the publish queue". The two halves are not the
 * same kind of failure and are deliberately not treated the same way.
 *
 * **Brand safety is a judgement.** Whether a joke is off-key for this author is
 * something a person can overrule, so a finding escalates: it reaches a human,
 * who may approve it anyway. That is what the existing gate already does.
 *
 * **Image rights are a fact.** Nobody at this company can grant a licence they
 * do not hold, so an unresolved or refused image is refused at publication even
 * after a human approves it — the same rule a superseded press kit has followed
 * since STORY-005. A reviewer can accept a risk on the author's behalf; they
 * cannot accept a licence on the rights-holder's behalf.
 *
 * Both lists are short and readable on purpose. This decides what reaches a
 * person and what may leave the building, so a reviewer has to be able to read
 * the rule that stopped their post.
 */

/**
 * Register this author does not use and would not want attached to the book.
 *
 * Not a profanity filter — a filter is a different tool for a different problem.
 * These are the failure modes of *memes about a book* specifically: punching at
 * an identifiable group, medical or financial claims, and the engagement-bait
 * register the voice profile already rejects for text.
 */
const UNSAFE_TERMS = [
  'cure', 'cures', 'guaranteed', 'get rich', 'miracle', 'weight loss',
  'idiots', 'idiot', 'morons', 'moron', 'stupid people', 'losers',
  'nobody tells you', 'they don\'t want you to know', 'doctors hate',
  'crypto', 'nft', 'investment advice',
];

/** Claims about a named third party are the fastest route to a legal problem. */
const THIRD_PARTY = /\b(?:according to|as .{0,20} said|per)\s+(?:dr\.?|professor|mr\.?|ms\.?|mrs\.?)\s+[A-Z]/;

/** Findings a person can weigh and overrule. */
export const SAFETY_FINDINGS = {
  UNSAFE_REGISTER: 'unsafe_register',
  THIRD_PARTY_CLAIM: 'third_party_claim',
  NO_ALT_TEXT: 'no_alt_text',
  CAPTION_OVER_LIMIT: 'caption_over_limit',
};

/** What the rights check can conclude. Mirrors `drafts.image_rights`. */
export const RIGHTS = {
  CLEARED: 'cleared',
  UNRESOLVED: 'unresolved',
  REFUSED: 'refused',
  NOT_APPLICABLE: 'not_applicable',
};

/**
 * Can this image be published, as a matter of fact rather than taste?
 *
 * An image with no provenance is `unresolved`, not `cleared`. The system does
 * not assume a licence it cannot point at, for the same reason it will not
 * guess an award result — a wrong answer here is not a bad post, it is a
 * rights-holder's letter.
 *
 * @returns {{rights: string, reason: string, attribution: string|null}}
 */
export function checkImageRights({ media }) {
  if (!media) return { rights: RIGHTS.NOT_APPLICABLE, reason: 'no image', attribution: null };

  const provenance = media.provenance;
  if (!provenance) {
    return {
      rights: RIGHTS.UNRESOLVED,
      reason: 'the image carries no provenance at all',
      attribution: null,
    };
  }

  const licence = provenance.licence;
  if (!licence) {
    return {
      rights: RIGHTS.UNRESOLVED,
      reason: `no licence recorded for ${provenance.templateId ?? provenance.source ?? 'this image'}`,
      attribution: null,
    };
  }

  if (licence.commercial !== true) {
    return {
      rights: RIGHTS.REFUSED,
      reason: `licence "${licence.terms}" from ${licence.holder} does not permit commercial use`,
      attribution: licence.attribution ?? null,
    };
  }

  // A licence that requires attribution and names nobody is not satisfiable,
  // so it is unresolved rather than cleared.
  if (licence.terms === 'cc-by' && !licence.attribution) {
    return {
      rights: RIGHTS.UNRESOLVED,
      reason: `licence "${licence.terms}" requires attribution and none is recorded`,
      attribution: null,
    };
  }

  return {
    rights: RIGHTS.CLEARED,
    reason: `licence "${licence.terms}" from ${licence.holder} permits this use`,
    attribution: licence.attribution ?? null,
  };
}

/**
 * Is this candidate safe to put in front of the author's audience?
 *
 * Findings only — this returns what is wrong, never what to do about it. The
 * escalation policy decides that, in one place, for the same reason STORY-008
 * moved the threshold comparison out of the three agents that each had a copy.
 *
 * @returns {{findings: string[], detail: object[], summary: string}}
 */
export function checkBrandSafety({ caption, media, maxChars = Infinity }) {
  const detail = [];
  const text = String(caption ?? '').toLowerCase();

  const hits = UNSAFE_TERMS.filter((term) => text.includes(term));
  if (hits.length > 0) {
    detail.push({
      finding: SAFETY_FINDINGS.UNSAFE_REGISTER,
      matched: hits,
      why: 'register the author does not use and would not want beside the book',
    });
  }

  if (THIRD_PARTY.test(String(caption ?? ''))) {
    detail.push({
      finding: SAFETY_FINDINGS.THIRD_PARTY_CLAIM,
      matched: [],
      why: 'attributes a claim to a named third party',
    });
  }

  // An image nobody can describe is an image half the audience cannot read.
  // A finding rather than a hard block: it is fixable, and a person should be
  // the one who decides to ship without it.
  if (media && !String(media.altText ?? '').trim()) {
    detail.push({
      finding: SAFETY_FINDINGS.NO_ALT_TEXT,
      matched: [],
      why: 'no alt text, so the post is unreadable to anyone using a screen reader',
    });
  }

  if (String(caption ?? '').length > maxChars) {
    detail.push({
      finding: SAFETY_FINDINGS.CAPTION_OVER_LIMIT,
      matched: [],
      why: `caption is ${caption.length} characters against a ${maxChars} limit`,
    });
  }

  const findings = detail.map((d) => d.finding);
  return {
    findings,
    detail,
    summary:
      findings.length === 0
        ? 'no brand-safety findings'
        : `withheld: ${detail.map((d) => d.why).join('; ')}`,
  };
}

/**
 * Both checks, for one candidate.
 *
 * Kept together because a caller wanting one almost always wants the other, and
 * separate because the two answers are different kinds of thing.
 */
export function reviewMemeCandidate({ caption, media, maxChars }) {
  const safety = checkBrandSafety({ caption, media, maxChars });
  const rights = checkImageRights({ media });
  return {
    findings: safety.findings,
    safetyDetail: safety.detail,
    safetySummary: safety.summary,
    rights: rights.rights,
    rightsReason: rights.reason,
    attribution: rights.attribution,
    // The one that outranks a human's approval.
    publishable: rights.rights === RIGHTS.CLEARED || rights.rights === RIGHTS.NOT_APPLICABLE,
  };
}
