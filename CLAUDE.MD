# Basecamp Updates — Short & Clear

**Who this is for:** This file instructs **Claude in Cursor** (where the Author Launch Engine code runs). After each task, Cursor's Claude does TWO things in this vault:
1. **Writes a short Basecamp update** → `09 PM Curriculum/Author Launch Engine/Basecamp Updates/`
2. **Updates the PM framework** → `09 PM Curriculum/Author Launch Engine/Product Management/`

**Why both:** The vault's Claude (Anvi's PM tutor) reads the Product Management folder to teach PM fundamentals from Anvi's *real* project work. So every update must also leave PM material behind — not just a status report.

**Goal of the update itself:** A normal person reads it in 30 seconds, understands exactly what got built.

---

## The goal (Colaberry's 4 questions)

A good update lets the reader answer four things fast:
1. **What did you work on?**
2. **What progress did you make?**
3. **What decisions did you make?**
4. **What are you doing next?**

Plus: **attach screenshots of the running product** showing the real work. Browser, not terminal — see Screenshots below.

## The 3 rules
1. **Tie to ONE task.** Always name it: `STORY-001`, release, todo. No "worked on stuff."
2. **Write short & plain.** Tell the story of what changed since the last update. No walls of text.
3. **Never post without Anvi's OK.** Claude drafts. Anvi posts.

---

## Template (copy & paste)

```
# <Task Name> — YYYY-MM-DD

**Task:** STORY-### or release name

**Worked on:**
[The specific thing you built/did this session — 1–2 plain sentences.]

**Progress made:**
[What you completed, changed, tested, or figured out. What a reviewer can now see or run.]

**Decisions:**
[The key approach or trade-off you made, and why — "chose X over Y because ___."]

**Next steps:**
[The one concrete thing you'll work on next.]

**Evidence:**
[Screenshots / artifacts / commit link showing the progress — caption each one.]
```

---

## Rules for this template

- **Worked on** = 1–2 sentences, plain English, tied to one named task.
- **Progress made** = what actually changed and how a reviewer can verify it (test passed, screen to open, demo command).
- **Decisions** = written as a trade-off ("chose X over Y because…"), never just "did X."
- **Next steps** = name the next story/task, not "figuring it out."
- **Evidence** = at least one captioned screenshot **of the app in a browser**. Show, don't just tell. See Screenshots below.
- **Keep it short** — it should tell the story of what changed since the last update, nothing more.

---

## Frontmatter (top of file)

```yaml
---
type: basecamp-update
date: YYYY-MM-DD
task: STORY-### or release name
status: draft
tags: [colaberry, author-launch-engine]
---
```

---

## File naming
`(C) YYYY-MM-DD — <Task Short Name>.md`

Example: `(C) 2026-08-10 — STORY-001 Draft Social Posts.md`

Save in: `09 PM Curriculum/Author Launch Engine/Basecamp Updates/`

---

## Screenshots — from the product, not the terminal

**Anvi's standing preference: screenshots come from the actual website.** Terminal output, demo
stage dumps and test summaries are *not* screenshots. They can appear in the Evidence section as
fenced text, but the captioned shots must be the app running in a browser.

```
npm run db:reset && npm run demo     # populate the database with real data first
npm run dev                          # then open http://localhost:5173
```
Run from `Author-Launch-Engine/`, not the folder above it. 5173 is the UI; 4000 is the API and
serves JSON, not pages. If the UI looks empty, `npm test` ran last and overwrote the data — reseed
with the two commands above.

Seeded logins:

| Login | Password | Use it for |
|---|---|---|
| `mira@example.test` | `quiet-craft` | the ordinary author view |
| `auditor@example.test` | `compliance-only` | read-everything, change-nothing (compliance) |
| `ops@example.test` | `ops-password` | admin / cross-tenant |
| `tomas@example.test` | `second-shelf` | the second tenant |

**Rules for the shots**
- Name the **tab and the panel**, so Anvi can find it without hunting: *"Trust tab, Ways out panel"*.
- **Pairs beat singles** when the story is a difference. Approve as the auditor (403) next to approve
  as the owner (200) is the story; either alone is a screenshot of a button.
- Caption every shot with *what it proves*, not what it is.
- Put the shot that carries the story on its own **first**.

**The rule this preference is really for — check it before writing the update:**
If a story's work cannot be screenshotted, it is probably **not surfaced in the product**. That has
been a real bug twice, both found only when a browser shot was asked for:

- STORY-019 — the Audit page pinned every request to one author id, so the compliance role was real
  in the API and invisible on screen.
- STORY-023 — the Outreach page showed only `confidence`, so the theme and voice scores the whole
  story added could not be seen by a reviewer.

So: **try to take the screenshot before you write the update.** Failing to find one is a finding
about the product, not about the screenshot.

---

## Plain-English Recap (for Anvi only)

Paste this at the bottom, below `<!-- NOT FOR BASECAMP -->`. Purpose: you can explain the work out loud without reading code.

```markdown
<!-- NOT FOR BASECAMP -->

**In one sentence:** [what this does, said to a friend]

**How it works**
1. [trigger/input]
2. [what happens]
3. [output/result]

**Files changed**
- `path/to/file` — [what it does now in one line, why it changed in one line]

**If it breaks:** [file or function to look at first]
```

Keep this under ~100 words. No jargon unless you define it.

---

## Before marking `ready-to-post`
- [ ] Answers all 4 questions: worked on / progress / decisions / next steps
- [ ] Tied to one named task
- [ ] Short — tells the story of what changed since last update, no walls of text
- [ ] Decisions written as a trade-off ("chose X over Y because…")
- [ ] Evidence attached — captioned screenshots **from the browser**, not the terminal
- [ ] Next steps names the actual next task
- [ ] Plain-English Recap is short & jargon-free
- [ ] Never posted to Basecamp yet (Anvi posts only)

---

## After each update — feed the PM framework (required, not optional)

Cursor's Claude must do this every time, so the vault's Claude can teach from it:

1. **Save the update** in `09 PM Curriculum/Author Launch Engine/Basecamp Updates/`.
2. **Update the PM framework** in `09 PM Curriculum/Author Launch Engine/Product Management/` — add the decision + result to the right file:

| What happened in the task | File to update |
|---|---|
| Scope, vision, or a strategic trade-off | `(C) 1. Product Strategy & Vision.md` |
| Learned something about a user/persona | `(C) 2. Personas & Jobs-to-be-Done.md` |
| A story shipped / roadmap moved | `(C) 3. Outcome Roadmap & Traceability.md` |
| A metric was hit or defined | `(C) 4. Metrics — North Star & Inputs.md` |
| A decision worth telling in an interview | `(C) 5. Progress → PM Story Bank.md` |

Front door for the framework: [[09 PM Curriculum/Author Launch Engine/Product Management/(C) Author Launch Engine — Start Here.md]]
