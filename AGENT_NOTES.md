# Deep Swipe Extension - Agent Workflow Notes

## Important: Direction of Workflow

**ALWAYS WORK IN THIS FOLDER FIRST → THEN EXPORT TO GIT**

```
[THIS FOLDER] → [TEST] → [COPY TO] → [GIT REPO] → [COMMIT/PUSH]
     ↑                                              ↓
     └──────────── EXPORT BACK ←────────────────────┘
```

## Folder Purposes

| Folder | Purpose | Git? |
|--------|---------|------|
| `h:\Silly\SillyTavern\public\scripts\extensions\third-party\deep-swipe` | **Development & Testing** | ❌ NO |
| `h:\Silly\Deep-Swipe` | **Git repository** | ✅ YES |

**DO NOT USE GIT IN THIS FOLDER** - The `.git` folder here belongs to SillyTavern's main repository, NOT the Deep-Swipe extension.

## Correct Workflow

1. **EDIT** files in THIS folder (`public\scripts\extensions\third-party\deep-swipe`)
2. **TEST** your changes live in SillyTavern
3. **EXPORT** to Git repo when ready to commit:
   ```cmd
   copy "h:\Silly\SillyTavern\public\scripts\extensions\third-party\deep-swipe\index.js" "h:\Silly\Deep-Swipe\index.js"
   copy "h:\Silly\SillyTavern\public\scripts\extensions\third-party\deep-swipe\manifest.json" "h:\Silly\Deep-Swipe\manifest.json"
   copy "h:\Silly\SillyTavern\public\scripts\extensions\third-party\deep-swipe\settings.html" "h:\Silly\Deep-Swipe\settings.html"
   copy "h:\Silly\SillyTavern\public\scripts\extensions\third-party\deep-swipe\style.css" "h:\Silly\Deep-Swipe\style.css"
   copy "h:\Silly\SillyTavern\public\scripts\extensions\third-party\deep-swipe\README.md" "h:\Silly\Deep-Swipe\README.md"
   ```
4. **COMMIT & PUSH** from `h:\Silly\Deep-Swipe`:
   ```cmd
   cd h:\Silly\Deep-Swipe
   git add .
   git commit -m "Your commit message"
   git push origin <branch>
   ```

## ⚠️ Common Mistakes to Avoid

- ❌ **NEVER** edit directly in `h:\Silly\Deep-Swipe` first
- ❌ **NEVER** run `git init`, `git add`, `git commit`, or `git push` from this testing folder
- ❌ **NEVER** copy FROM git repo TO testing folder (you'll lose uncommitted work)

## Repository Information

- **GitHub URL:** https://github.com/Rurijian/Deep-Swipe
- **Local Git Repo:** `h:\Silly\Deep-Swipe`
- **Testing Folder:** `h:\Silly\SillyTavern\public\scripts\extensions\third-party\deep-swipe` (this folder)

## Branches

- `master` - Main/stable branch (default)
- `dev` - Development branch (for experimental features)

## Important Notes

- The `.git` folder in this directory belongs to SillyTavern's main repository, NOT the Deep-Swipe extension
- Never run `git init`, `git add`, `git commit`, or `git push` from this folder
- Always use `h:\Silly\Deep-Swipe` for git operations
