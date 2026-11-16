# Everyday Git for WaveSend

A short cheat sheet. Run these in **Git Bash** or **PowerShell** inside the `wavesend` folder, or use the matching button in **GitHub Desktop**.

## The daily loop: change → save → upload

| What you want | Command | GitHub Desktop |
|---|---|---|
| See what changed | `git status` | "Changes" tab |
| Stage everything | `git add .` | tick the files |
| Save a snapshot | `git commit -m "Fix: attachment send button"` | Summary box → **Commit to main** |
| Upload to GitHub | `git push` | **Push origin** |
| Download latest (other PC) | `git pull` | **Fetch / Pull origin** |

**Before every commit, check `git status` and make sure no contact lists, reports or backups are in it.**

## Good commit messages
Start with what kind of change it is:
- `Fix: STOP detection after WhatsApp layout change`
- `Add: weekly repeat for scheduled campaigns`
- `Change: shorter typing delay`
- `Release: v2.1.2`

## Releasing a new version
1. Bump `"version"` in `manifest.json` (e.g. `2.1.1` → `2.1.2`).
2. Add an entry at the top of `CHANGELOG.md`.
3. Commit and tag it:
   ```bash
   git add .
   git commit -m "Release: v2.1.2"
   git tag v2.1.2
   git push
   git push --tags
   ```
4. Optional: on GitHub go to **Releases → Draft a new release**, pick the tag, and attach a `.zip` of the folder.

## Trying something risky (branches)
```bash
git switch -c experiment/new-attach-flow   # make a safe copy line
# …edit, commit as usual…
git push -u origin experiment/new-attach-flow
```
- It works → open a Pull Request on GitHub and merge it into `main`.
- It doesn't → `git switch main` and the experiment never touches your working version.

## Undo buttons
| Problem | Fix |
|---|---|
| Undo edits to one file (not committed yet) | `git restore content.js` |
| Unstage a file you added by mistake | `git restore --staged contacts.csv` |
| Fix the last commit message | `git commit --amend -m "Better message"` |
| Go back to how things were at v2.1.1 (just to look) | `git switch --detach v2.1.1`, then `git switch main` to return |
| See history | `git log --oneline` |

## If you accidentally pushed a contact list
1. `git rm --cached thefile.csv`, then commit and push.
2. The file stays in the **history**. If it held real numbers, ask Claude to help purge it, or delete and recreate the repo while it's still small.
