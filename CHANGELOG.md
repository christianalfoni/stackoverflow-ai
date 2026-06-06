# Change Log

## 0.0.3

- Ask a question regardless of what's focused in the editor — an open file is no longer required. The `cmd+alt+a` / `ctrl+alt+a` shortcut now works anywhere (terminal, sidebar, or with no editor open at all).

## 0.0.2

- Answers are strictly generic — they never review, diagnose, or reference your code, files, or project structure; you get a real Stack Overflow-style thread, not a code review.
- Version-accurate help: instead of reading your source, the agent inspects your project's dependencies and their installed versions (package.json + lock file) and consults docs for those versions.
- Your question is shown verbatim as the post — nothing is written on your behalf, and the duplicate title bar is gone.
- Answer authors are humorous riffs on well-known names from the relevant tech ecosystem.
- Answers can cite the documentation pages the agent actually fetched.
- Live activity log shows the agent's research, with a fun state while it composes the answers.
- Faster: no file contents sent on each ask, and the thread renders as soon as the answers are ready (no waiting on a wrap-up turn).
- Code blocks widen the page horizontally instead of scrolling in a cramped box.

## 0.0.1

Initial release.

- Ask a coding question inline (`cmd+alt+a` / `ctrl+alt+a`) and get answers in a Stack Overflow-style thread.
- Multiple competing answers with vote counts and one accepted ✓.
- Read-only Claude agent grounds answers in your actual files and the web.
- Theme-aware webview with syntax highlighting and copy-to-clipboard on code blocks.
