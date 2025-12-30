# Repository Guidelines

## Project Structure & Module Organization
This repo is a small Node.js script for exporting Supabase data into an Obsidian vault.
- `export-obsidian.mjs` holds all script logic (CLI parsing, Supabase fetches, note generation).
- `export-obsidian.md` documents behavior, output structure, and options.
- `.env.example` shows required environment variables; copy to `.env` for local runs.
- `AGENTS.md` (this file) describes contribution expectations.

There is no separate `src/` or `tests/` directory; keep changes localized and well-organized within `export-obsidian.mjs`.

## Build, Test, and Development Commands
- `node export-obsidian.mjs --out /path/to/Vault` runs the exporter.
- `node export-obsidian.mjs --env /path/to/.env --out /path/to/Vault` overrides the env file.
- `node export-obsidian.mjs --help` prints CLI usage.

No build step is required. There are no automated tests in this repository.

## Coding Style & Naming Conventions
- JavaScript (ES modules) with 2-space indentation and semicolons.
- Prefer clear function names that describe behavior (`inferYear`, `buildIssueNote`).
- Keep helper utilities (formatting, slugging, data fetchers) as small, pure functions when possible.
- Avoid introducing new dependencies unless required for core functionality.

## Testing Guidelines
- No test framework is configured.
- If you add tests, document how to run them and keep them lightweight (e.g., a `node` script).
- For manual validation, run the exporter against a test vault and inspect generated notes.

## Commit & Pull Request Guidelines
- No Git history is available to infer conventions. Use concise, imperative commit messages (e.g., "Add year inference fallback").
- PRs should include a brief description of changes, expected output differences, and any new environment requirements.
- If output structure changes, update `export-obsidian.md` and include a small example in the PR description.

## Configuration Notes
- Required env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- Default env resolution: `./.env` if present, otherwise `./kitanocr-web/.env`.
- Output directories (`Overview.md`, `Years/`, `Issues/`, `Pages/`) are overwritten each run.
