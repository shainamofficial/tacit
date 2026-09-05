# Session 0 — Bootstrap (run once, then delete this file)

Paste this as your first message to Claude Code in this folder:

---

Read CLAUDE.md first. Then bootstrap this repo:

1. `git init -b main`, add everything, and make the founding commit:
   "docs: founding documents — PRD, implementation plan, CLAUDE.md, playbook"
2. Add the remote `https://github.com/shainamofficial/tacit.git` and push `main` upstream.
   - If the push fails with auth errors, stop and tell me exactly what to run
     (e.g. `gh auth login`) — do not attempt workarounds.
   - If the remote isn't empty, stop and show me what's there before doing anything.
3. Verify prerequisites for Session 1 and report versions: node (need 22+),
   pnpm (enable via corepack if missing), docker, git. List anything missing
   with the install command for my OS — do not install system-level tools yourself.
4. Delete this BOOTSTRAP.md, commit the deletion, push.
5. Then stop and summarize the project and your working constraints from
   CLAUDE.md so I can confirm you've internalized them before Session 1.

---

After Session 0 succeeds, continue with Session 1 in docs/claude-code-playbook.md.
