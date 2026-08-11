# Basecamp Updates — Formatting Rules

This file governs how Claude drafts **every** Basecamp update in this folder. Match it exactly.
Source of the format: Colaberry onboarding requires updates **tied to a specific task**, following
**What → Progress → Decisions → Next**, with **screenshots**.

## Hard rules
1. **Tie every update to ONE specific task** (a named backlog story / release / todo). No vague "worked on stuff."
3. **Momentum > perfection.** "I'm stuck" only counts if it names the next concrete step.
4. **Never post to Basecamp without my explicit permission.** Draft only. I post.
5. **Every file ends with a Plain-English Recap** (see below). It is for me, not for Basecamp.
6. **Before a ticket is closed, give a detailed stage report — never a terse summary.** The update must answer, in depth: *what did you do this stage, what were the results, and what are the deliverables?* Tell us what the code produced

## File naming
`(C) YYYY-MM-DD — <ShortTaskName>.md` (e.g. `(C) 2026-07-12 — STORY-004 Daily Refresh Engine.md`)
All Claude-drafted files keep the `(C)` prefix.

## Required frontmatter
```yaml
---
type: basecamp-update
project: Colaberry Internship
sub-project: IPOS
release: <e.g. R1 — Core Build>, correspond to the basecamp
date: YYYY-MM-DD
task: <STORY-### or milestone name>
status: <draft | posted-ready | posted (comment #) — screenshots pending>
tags: [colaberry, basecamp-update, ipos, <story/release slug>]
---
```

## Part 1 — The Basecamp update (copy-paste this part only)

```markdown
# (C) Basecamp Update — <Task Short Name> (YYYY-MM-DD)

> Format per Colaberry onboarding: tied to a specific task → **What → Progress → Decisions → Next**
> + screenshots. Linked PM detail: [[...link to the relevant PM Layer / case-study note...]].

---

**📌 Task:** <STORY-### or milestone> · pushed to GitHub `main` (commit `<hash>` if applicable)

**✅ What I did**
2–4 sentences, plain English, what got built/done end to end.

**📈 Progress**
- Bullet the concrete, verifiable results (tests passing, scenarios met, what a reviewer can see).
- Bold the acceptance-criteria hits. Note any live-verified behavior.
- Always surface the Trust-Before-Intelligence / audit-log evidence when relevant.

**🧠 Decisions & trade-offs**
- Each bullet = a decision + the *why* (the PM reasoning). This is the interview-gold section.
- Include a **Traceability:** line mapping the work to REQ-### / STORY-###.

**📦 Deliverables** *(required — what a reviewer can open right now)*
- One bullet per artifact produced this stage, each with where to find it: e.g.
  what code was commited, artifacts

**➡️ Next**
What unlocks next for us to accomplish


---

## Demo notes / credentials (for reviewer)
- Exact steps or logins so the reviewer can reproduce it in under a minute.
```

## Part 2 — Plain-English Recap (for me only, NEVER posted)

Goes below a `<!-- NOT FOR BASECAMP -->` marker at the bottom of the file. Purpose: I should be
able to read this and explain, out loud, exactly what got built without opening the code.

```markdown
<!-- NOT FOR BASECAMP -->
---

## 🧾 Plain-English Recap

**In one sentence:** <what this change actually does, said like you'd say it to a friend>

**Files touched**
| File | What it does now | Why it changed |
|---|---|---|
| `path/to/file.py` | <one line, no jargon> | <one line> |

**How it works, step by step**
1. <trigger — what kicks this off>
2. <what happens next, in order>
3. <where the data ends up>

**New words / concepts introduced**
- **<term>** — <plain definition, one sentence, no other jargon inside it>

**If it breaks, look here first:** <file or function + the most likely failure>
```

Rules for this section:
- No jargon unless it's defined right there. Say "a background job that reruns every night," not "a cron-scheduled idempotent refresh."
- Prefer analogies over precision when they conflict.
- If Claude wrote code, every file it touched must appear in the table. No silent changes.
- Keep it under ~250 words.

## Tone & length (Part 1 only)
- **Concise, confident, specific.** Short sentences. No filler, no hype.
- Show the reviewer can *verify* it (steps, credentials, commit hash, passing scenarios).
- Bold the acceptance criteria and key decisions so a busy PM can scan in 15 seconds.
- Write decisions as trade-offs ("chose X over Y because…"), never just "did X."

## Where to save these files
- Save these files in Documents --> Anvi's Second Brain --> 02 Projects --> 05 Basecamp Updates

## Before marking `posted-ready`
- [ ] Tied to one named task
- [ ] **Multiple captioned screenshots** listed in Attachments (≥1 per acceptance criterion / demo step) — not a single image
- [ ] **Deliverables section present**, listing every artifact with where to find it (commit hash, test command + result, doc paths, demo login)
- [ ] **Detailed stage report** — what I did / the results / the deliverables are all answered in depth, with evidence (commit, test output, live-verified behavior), not a terse summary
- [ ] Decisions section has a Traceability line
- [ ] Demo/repro steps included
- [ ] Next step is concrete (not "figuring it out")
- [ ] Plain-English Recap written, and it's below the `<!-- NOT FOR BASECAMP -->` marker
- [ ] Every file Claude touched appears in the Recap table