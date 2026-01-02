# Export Obsidian Script

## Overview
`export-obsidian.mjs` exports the Supabase database into an Obsidian-friendly
folder structure. It pulls issues, pages, and OCR generation history, then
writes Markdown notes that link to each other.

This script mirrors the `.env` loading pattern used in other root scripts.

## What It Exports
- Issues (from `public.issues`)
- Pages (from `public.pages`)
- OCR generations (from `public.ocr_generations`)

Each issue is grouped into a year based on `publication_date`, `title`, or
`volume` (see "Year inference" below).

## Output Structure
The export creates (or updates) these files under the target folder:

- `Overview.md`
- `Years/<year>.md`
- `Issues/<issue-slug>.md`
- `Generations/<issue-slug>-page-###-gen-<id>.md`
- `Authors/<author-slug>.md`
- `Tags/<tag-slug>.md`

Where:
- `<year>` is a 4-digit year or `unknown`
- `<issue-slug>` is a lowercase, dash-separated slug derived from the issue title
- `###` is zero-padded page number (e.g., `001`)

## Note Contents
`Overview.md`
- Links to each year and issue.

`Years/<year>.md`
- Links to all issues in that year.
- Summary lists of authors and tags that appear in that year's issues.

`Issues/<issue-slug>.md`
- Metadata: id, volume, publication_date, created_at, updated_at
- Stats: total pages, pages with OCR text, pages with OCR generations
- Authors and tags with links to per-author/per-tag notes
- Related generation links for the issue
- One line per page with an online image link and OCR generation links

`Generations/<issue-slug>-page-###-gen-<id>.md`
- Metadata: generation id, page id, issue id, created_at, model, image_path
- OCR prompt/output from `ocr_generations`
- Backlinks to the parent issue and year notes

`Authors/<author-slug>.md`
- Issue links grouped for that author with inferred years
- Backlinks to year notes where the author appears

`Tags/<tag-slug>.md`
- Issue links grouped for that tag with inferred years
- Backlinks to year notes where the tag appears

## Environment Variables
Required:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
Optional:
- `VITE_IMAGE_BASE_URL` (prefix for `pages.image_path` when linking images)

Optional:
- `OBSIDIAN_EXPORT_DIR` (used if `--out` is not provided)

The script looks for `.env` in:
1) `./.env` (project root) if present
2) `./kitanocr-web/.env` otherwise

You can override with `--env <path>`.

## Usage
```bash
node export-obsidian.mjs --out /path/to/ObsidianVault
```

Other CLI options:
- `--out`, `--folder`, or `--vault` to set output folder
- `--env <path>` to set the env file
- `-h` or `--help` to print usage

## Database Assumptions
Tables and columns used:

`public.issues`
- `id`, `title`, `volume`, `publication_date`, `created_at`, `updated_at`

`public.pages`
- `id`, `issue_id`, `page_number`, `image_path`, `status`, `ocr_text`,
  `created_at`, `updated_at`

`public.ocr_generations`
- `id`, `page_id`, `model`, `prompt`, `output`, `metadata`, `created_at`

If columns are added/removed, update the `select('*')` fields or note templates.

## Year Inference Logic
Year is determined in this order:
1) `publication_date` (parsed as UTC year)
2) `title`/`volume` containing a 4-digit year
3) `title`/`volume` that looks like `YYYYMM` or `YYYYMMDD` (uses first 4)
4) Fallback to `unknown`

To change this behavior, update `inferYear()` in `export-obsidian.mjs`.

## Slugging Rules
Issue slugs:
- Lowercase
- Non-alphanumeric replaced with `-`
- Multiple dashes collapsed

To change this behavior, update `slugify()` in `export-obsidian.mjs`.

## Maintenance Notes
- Export pagination is fixed at 1000 rows per request.
- Obsidian notes are overwritten on each run.
- OCR generation history is written to separate generation notes.

If exports become large, consider:
- Adding filters (by year, issue, or page range)
- Splitting OCR generations into separate notes
- Using `select()` with only necessary columns to reduce payload size
