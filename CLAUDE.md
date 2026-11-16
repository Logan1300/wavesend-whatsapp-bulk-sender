# Notes for Claude: working on WaveSend

The owner is not a developer. Claude makes the changes and handles all Git work. Keep explanations simple.

## Every update
1. Make the code change.
2. Bump `"version"` in `manifest.json` (patch for fixes: 2.1.1 → 2.1.2; minor for features: 2.1 → 2.2).
3. Add an entry at the top of `CHANGELOG.md` (Added / Changed / Fixed, in plain English).
4. Commit to `main` with a clear message (`Fix: …`, `Add: …`, `Release: v2.1.2`).
5. Push `main`, then save the version snapshot as a branch:
   `git push origin main:refs/heads/version/vX.Y.Z`
   (Tag pushes are refused by the session proxy, so **version branches replace tags**.)
6. Give the owner the updated extension: a zip of the repo (without `.git`), or write the files into their folder if their computer is linked. Remind them to click ↻ on the WaveSend card in `chrome://extensions` and reload WhatsApp Web.

## Going back to a working version
- List versions: `git ls-remote --heads origin 'version/*'`
- Restore the files from a version as a NEW commit on main (never rewrite history):
  `git fetch --depth 1 origin version/vX.Y.Z && git checkout FETCH_HEAD -- . && git commit -m "Revert to vX.Y.Z"`, then push.
  Only the extension files come back. Keep this `CLAUDE.md` and `docs/` at their latest version, even when the old snapshot has older copies or none.
- Then hand the files to the owner as in step 6.

## Rules
- Never put the owner's real name (or any personal name) in any file, commit message or version. The GitHub username Logan1300 is the only identity to use.
- Never commit contact lists, reports or backups (real phone numbers). Check `git status` before committing. `sample_contacts.csv` is made-up data and is allowed.
- Never force-push or delete `version/*` branches.
- WhatsApp Web selectors are in `SEL` at the top of `content.js`. When the layout changes, ask the owner for a Diagnose report from the extension.
