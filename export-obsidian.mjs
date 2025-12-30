import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    outDir: null,
    envPath: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--out' || arg === '--folder' || arg === '--vault') {
      options.outDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--out=')) {
      options.outDir = arg.split('=').slice(1).join('=');
      continue;
    }
    if (arg.startsWith('--folder=')) {
      options.outDir = arg.split('=').slice(1).join('=');
      continue;
    }
    if (arg.startsWith('--vault=')) {
      options.outDir = arg.split('=').slice(1).join('=');
      continue;
    }
    if (arg === '--env') {
      options.envPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--env=')) {
      options.envPath = arg.split('=').slice(1).join('=');
      continue;
    }
    if (!options.outDir && !arg.startsWith('-')) {
      options.outDir = arg;
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node export-obsidian.mjs --out <folder> [--env <path>]

Options:
  --out, --folder, --vault   Destination Obsidian folder
  --env                      Path to .env (defaults to ./.env if present,
                             otherwise ./kitanocr-web/.env)
  -h, --help                 Show help
`);
}

function resolveEnvPath(explicitPath) {
  if (explicitPath) return explicitPath;
  const rootEnv = join(__dirname, '.env');
  if (existsSync(rootEnv)) return rootEnv;
  return join(__dirname, 'kitanocr-web', '.env');
}

function slugify(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function inferYear(issue) {
  if (issue.publication_date) {
    const parsed = new Date(issue.publication_date);
    if (!Number.isNaN(parsed.valueOf())) {
      return String(parsed.getUTCFullYear());
    }
  }

  const candidates = [issue.title, issue.volume];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = String(candidate);
    const match = text.match(/\b(19|20)\d{2}\b/);
    if (match) return match[0];
    if (/^\d{6,8}$/.test(text)) return text.slice(0, 4);
    const fallback = text.match(/\b(19|20)\d{2}/);
    if (fallback) return fallback[0];
  }

  return 'unknown';
}

async function fetchAll(supabase, table, select, orderBy = []) {
  const pageSize = 1000;
  let offset = 0;
  const allRows = [];

  while (true) {
    let query = supabase
      .from(table)
      .select(select)
      .range(offset, offset + pageSize - 1);

    for (const order of orderBy) {
      query = query.order(order.column, { ascending: order.ascending ?? true });
    }

    const { data, error } = await query;
    if (error) throw new Error(`Supabase error (${table}): ${error.message}`);
    if (!data || data.length === 0) break;

    allRows.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return allRows;
}

function formatDate(value) {
  if (!value) return 'unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return String(value);
  return parsed.toISOString();
}

function buildOverview({ years, issues }) {
  const lines = ['# Kitan OCR Export', '', '## Years'];
  const yearEntries = Object.entries(years).sort(([a], [b]) => a.localeCompare(b));
  for (const [year, issueList] of yearEntries) {
    const label = year === 'unknown' ? 'Unknown' : year;
    lines.push(`- [[Years/${year}|${label}]] (${issueList.length} issues)`);
  }

  lines.push('', '## Issues');
  const sortedIssues = [...issues].sort((a, b) => String(a.title).localeCompare(String(b.title)));
  for (const issue of sortedIssues) {
    const issueSlug = slugify(issue.title || issue.id);
    lines.push(`- [[Issues/${issueSlug}|${issue.title || issue.id}]]`);
  }

  return lines.join('\n');
}

function buildYearNote(year, issues) {
  const lines = [`# ${year === 'unknown' ? 'Unknown Year' : year}`, '', '## Issues'];
  const sorted = [...issues].sort((a, b) => String(a.title).localeCompare(String(b.title)));
  for (const issue of sorted) {
    const issueSlug = slugify(issue.title || issue.id);
    lines.push(`- [[Issues/${issueSlug}|${issue.title || issue.id}]]`);
  }
  return lines.join('\n');
}

function buildIssueNote(issue, pages, stats) {
  const lines = [
    `# ${issue.title || issue.id}`,
    '',
    '## Metadata',
    `- id: ${issue.id}`,
    `- volume: ${issue.volume || 'unknown'}`,
    `- publication_date: ${issue.publication_date || 'unknown'}`,
    `- created_at: ${formatDate(issue.created_at)}`,
    `- updated_at: ${formatDate(issue.updated_at)}`,
    '',
    '## Page Stats',
    `- total_pages: ${stats.totalPages}`,
    `- pages_with_text: ${stats.pagesWithText}`,
    `- pages_with_generations: ${stats.pagesWithGenerations}`,
    '',
    '## Pages',
  ];

  const sorted = [...pages].sort((a, b) => (a.page_number || 0) - (b.page_number || 0));
  for (const page of sorted) {
    const pageLabel = `Page ${String(page.page_number || 0).padStart(3, '0')}`;
    const imageUrl = resolveImageUrl(page);
    const generationLinks = (page.ocr_generations || []).map((generation) => {
      const generationSlug = buildGenerationSlug(issue, page, generation);
      return `[[Generations/${generationSlug}|${formatDate(generation.created_at)}]]`;
    });
    const imagePart = imageUrl ? `[Image](${imageUrl})` : 'Image unavailable';
    const ocrPart = generationLinks.length ? `OCR: ${generationLinks.join(', ')}` : 'OCR: none';
    lines.push(`- ${pageLabel}: ${imagePart} | ${ocrPart}`);
  }

  return lines.join('\n');
}

function buildGenerationNote(issue, page, generation) {
  const lines = [
    `# ${issue.title || issue.id} Page ${String(page.page_number || 0).padStart(3, '0')} OCR`,
    '',
    '## Metadata',
    `- id: ${generation.id}`,
    `- page_id: ${page.id}`,
    `- issue_id: ${page.issue_id}`,
    `- issue_title: ${issue.title || issue.id}`,
    `- page_number: ${page.page_number ?? 'unknown'}`,
    `- status: ${page.status || 'unknown'}`,
    `- image_path: ${page.image_path || 'unknown'}`,
    `- created_at: ${formatDate(generation.created_at)}`,
    `- model: ${generation.model || 'unknown'}`,
  ];

  if (generation.output) {
    lines.push('', '## Output', '', '```', String(generation.output), '```');
  } else {
    lines.push('', '## Output', '', '_No output stored._');
  }

  return lines.join('\n');
}

function buildGenerationSlug(issue, page, generation) {
  const issueSlug = slugify(issue.title || issue.id);
  const pageNumber = String(page.page_number || 0).padStart(3, '0');
  return `${issueSlug}-page-${pageNumber}-gen-${generation.id}`;
}

function resolveImageUrl(page) {
  const imagePath = page.image_path ? String(page.image_path).trim() : '';
  if (!imagePath) return '';
  if (/^https?:\/\//i.test(imagePath)) return imagePath;
  const baseUrl = process.env.VITE_IMAGE_BASE_URL ? String(process.env.VITE_IMAGE_BASE_URL).trim() : '';
  if (!baseUrl) return imagePath;
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
  return `${trimmedBase}/${trimmedPath}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const envPath = resolveEnvPath(options.envPath);
  config({ path: envPath });

  const outDir = options.outDir || process.env.OBSIDIAN_EXPORT_DIR;
  if (!outDir) {
    throw new Error('Missing output folder. Use --out <folder> or set OBSIDIAN_EXPORT_DIR.');
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase credentials. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.');
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('Fetching issues, pages, and OCR generations...');
  const issues = await fetchAll(supabase, 'issues', '*', [
    { column: 'title', ascending: true },
  ]);
  const pages = await fetchAll(supabase, 'pages', '*', [
    { column: 'issue_id', ascending: true },
    { column: 'page_number', ascending: true },
  ]);
  const ocrGenerations = await fetchAll(supabase, 'ocr_generations', '*', [
    { column: 'created_at', ascending: true },
  ]);

  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const pagesByIssue = new Map();
  for (const page of pages) {
    if (!pagesByIssue.has(page.issue_id)) pagesByIssue.set(page.issue_id, []);
    pagesByIssue.get(page.issue_id).push(page);
  }

  const ocrByPage = new Map();
  for (const generation of ocrGenerations) {
    if (!generation.page_id) continue;
    if (!ocrByPage.has(generation.page_id)) ocrByPage.set(generation.page_id, []);
    ocrByPage.get(generation.page_id).push(generation);
  }

  const years = {};
  for (const issue of issues) {
    const year = inferYear(issue);
    if (!years[year]) years[year] = [];
    years[year].push(issue);
  }

  const yearsDir = join(outDir, 'Years');
  const issuesDir = join(outDir, 'Issues');
  const generationsDir = join(outDir, 'Generations');
  await mkdir(yearsDir, { recursive: true });
  await mkdir(issuesDir, { recursive: true });
  await mkdir(generationsDir, { recursive: true });

  const overviewContent = buildOverview({ years, issues });
  await writeFile(join(outDir, 'Overview.md'), overviewContent, 'utf8');

  const sortedYears = Object.entries(years).sort(([a], [b]) => a.localeCompare(b));
  for (const [year, issueList] of sortedYears) {
    console.log(`Processing year ${year} (${issueList.length} issues)...`);
    const yearContent = buildYearNote(year, issueList);
    await writeFile(join(yearsDir, `${year}.md`), yearContent, 'utf8');

    let totalPagesForYear = 0;
    for (const issue of issueList) {
      const issuePages = pagesByIssue.get(issue.id) || [];
      totalPagesForYear += issuePages.length;
      for (const page of issuePages) {
        page.ocr_generations = ocrByPage.get(page.id) || [];
      }
      const stats = {
        totalPages: issuePages.length,
        pagesWithText: issuePages.filter((page) => page.ocr_text || page.status === 'completed').length,
        pagesWithGenerations: issuePages.filter((page) => (ocrByPage.get(page.id) || []).length > 0).length,
      };
      const issueContent = buildIssueNote(issue, issuePages, stats);
      const issueSlug = slugify(issue.title || issue.id);
      await writeFile(join(issuesDir, `${issueSlug}.md`), issueContent, 'utf8');

      for (const page of issuePages) {
        const generations = ocrByPage.get(page.id) || [];
        for (const generation of generations) {
          const generationSlug = buildGenerationSlug(issue, page, generation);
          const generationContent = buildGenerationNote(issue, page, generation);
          await writeFile(join(generationsDir, `${generationSlug}.md`), generationContent, 'utf8');
        }
      }
    }

    console.log(`Finished year ${year}: ${issueList.length} issues, ${totalPagesForYear} pages.`);
  }

  console.log(`Export complete. Wrote notes to ${outDir}`);
}

main().catch((err) => {
  console.error(`\nExport failed: ${err.message}`);
  process.exit(1);
});
