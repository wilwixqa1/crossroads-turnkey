# How we work on this repo

Borrowed from the SimpleBlueprints workflow, trimmed for a one-week project.

## Sessions

- Sessions are numbered T01, T02, ... (T for Turnkey, to keep them apart from SimpleBlueprints' S-numbers).
- Will pastes a GitHub token in chat at the start of each session; Claude clones this repo with it.
- Every session ends with the four-part close-out, in order:
  1. Add "what would the next person need to know?" comments in the code wherever a gotcha, dual-path contract, or hidden constraint lives.
  2. Write `docs/sessions/Txx_CONTEXT.md` (what was done, what is next, lessons).
  3. Update `docs/BACKLOG.md` (mark done, add new items).
  4. Present the context file to Will.
- Re-export the Claude Doc SoW to `docs/SOW.md` at close-out if it changed.

## Code comments: rules that make the step actually happen

The comments step is the only close-out step with no artifact of its own, which is why it gets skipped, and comment edits are where real code has gone missing before. Four rules:

1. Write the comment when the gotcha is found, during the session. Close-out only verifies the question was considered.
   The bar: a fact the next session would otherwise trip over, placed where they would be standing when it matters. "None needed" is a normal and common answer. A comment that restates what the code plainly does makes future sessions slower, not faster, and should be removed.
2. Insert-only edits: find one unique existing line, replace it with the comment plus that identical line. The old text is contained in the new text, so nothing can be deleted.
3. Commit comments on their own with a message starting `comments:`. The gate (`tools/check_comment_commit.sh`) fails such a commit if it removes a single line.
4. Close-out step 1 is done only when the context file has a `## Code comments` section listing each comment with its location (or saying none were needed) and the diff summary shows zero lines removed. The gate (`tools/check_context_file.sh`) fails if the newest context file lacks that section.

Comment style: start with `NEXT PERSON:` and say what to do, not what happened.

## Where knowledge lives (one place each)

- `docs/SOW.md`: the design. Why things are the way they are.
- `docs/BACKLOG.md`: actionable work only.
- Code comments: facts that are not work (dead ends, "monitor, do not chase", hidden constraints), placed where the next person would be standing when it matters.
- `docs/sessions/`: per-session handoff files, including process lessons.
- No other notes files.

## Gate

Before every push: `npm test`, `npm run typecheck`, and `npm run build:web` must pass. CI runs the same on every push (`.github/workflows/ci.yml`). One push at a time, read before edit.

## Plain English rule

Session updates and context files describe what changed and what it means for Will, not file names or tooling internals. File paths appear only where the next Claude session needs them.

## Configuration

`.env` is never committed. `.env.example` lists every setting. In ROFL the same settings become ROFL secrets. The vault's Turnkey keys are generated inside the enclave and never appear in any file.
