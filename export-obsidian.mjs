import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    outDir: null,
    envPath: null,
    help: false,
    incremental: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--incremental') {
      options.incremental = true;
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
  --incremental              Only write new OCR generations and affected issues
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
  const lines = ['# Kitan OCR Export', '', '## Logs', '- [[Logs/Export Log|Export Log]]', '', '## Years'];
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

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function getIssueAuthors(issue) {
  if (!issue) return [];
  const authors = normalizeList(issue.authors ?? issue.author);
  return Array.from(new Set(authors));
}

function getIssueTags(issue) {
  if (!issue) return [];
  return Array.from(new Set(normalizeList(issue.tags)));
}

function deriveAuthorAggregates(issues) {
  const authors = new Map();
  for (const issue of issues) {
    for (const author of getIssueAuthors(issue)) {
      if (!authors.has(author)) authors.set(author, []);
      authors.get(author).push(issue);
    }
  }
  return authors;
}

function deriveTagAggregates(issues) {
  const tags = new Map();
  for (const issue of issues) {
    for (const tag of getIssueTags(issue)) {
      if (!tags.has(tag)) tags.set(tag, []);
      tags.get(tag).push(issue);
    }
  }
  return tags;
}

function sortIssuesByCreatedAt(issues) {
  return [...issues].sort((a, b) => {
    const aTime = new Date(a.created_at || 0).valueOf();
    const bTime = new Date(b.created_at || 0).valueOf();
    return bTime - aTime;
  });
}

function buildAuthorDashboard(authorAggregates) {
  const lines = ['# Issues by Author', '', '## Authors'];
  const authorEntries = Array.from(authorAggregates.entries()).sort(([a], [b]) =>
    String(a || '').localeCompare(String(b || ''))
  );

  for (const [author, issueList] of authorEntries) {
    const authorLabel = author || 'Unknown Author';
    const authorSlug = slugify(authorLabel);
    const issueCount = issueList.length;
    lines.push(`- [[Pages/Authors/${authorSlug}|${authorLabel}]] (${issueCount} issues)`);

    const sortedIssues = [...issueList].sort((a, b) =>
      String(a.title || a.id).localeCompare(String(b.title || b.id))
    );
    for (const issue of sortedIssues) {
      const issueSlug = slugify(issue.title || issue.id);
      lines.push(`  - [[Issues/${issueSlug}|${issue.title || issue.id}]]`);
    }
  }

  return lines.join('\n');
}

function buildTagDashboard(tagAggregates) {
  const lines = ['# Issues by Tag', '', '## Tags'];
  const tagEntries = Array.from(tagAggregates.entries()).sort(([a], [b]) =>
    String(a || '').localeCompare(String(b || ''))
  );

  for (const [tag, issueList] of tagEntries) {
    const tagLabel = tag || 'untagged';
    const tagSlug = slugify(tagLabel);
    const issueCount = issueList.length;
    lines.push(`- [[Pages/Tags/${tagSlug}|${tagLabel}]] (${issueCount} issues)`);

    const sortedIssues = [...issueList].sort((a, b) =>
      String(a.title || a.id).localeCompare(String(b.title || b.id))
    );
    for (const issue of sortedIssues) {
      const issueSlug = slugify(issue.title || issue.id);
      lines.push(`  - [[Issues/${issueSlug}|${issue.title || issue.id}]]`);
    }
  }

  return lines.join('\n');
}

function buildRecentExportsDashboard(issues, limit = 50) {
  const lines = ['# Recent Exports', '', '## Most Recent Issues'];
  const recentIssues = issues.slice(0, limit);

  for (const issue of recentIssues) {
    const issueSlug = slugify(issue.title || issue.id);
    const createdAt = formatDate(issue.created_at);
    lines.push(`- [[Issues/${issueSlug}|${issue.title || issue.id}]] (${createdAt})`);
  }

  return lines.join('\n');
}

function buildYearNote(year, issues) {
  const lines = [
    `# ${year === 'unknown' ? 'Unknown Year' : year}`,
    '',
    '## Logs',
    '- [[Logs/Export Log|Export Log]]',
    '',
    '## Issues',
  ];
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

function generationFilePath(generationsDir, generationSlug) {
  return join(generationsDir, `${generationSlug}.md`);
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

async function loadState(statePath) {
  if (!existsSync(statePath)) return {};
  try {
    const content = await readFile(statePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.warn(`Failed to read state file, continuing: ${err.message}`);
    return {};
  }
}

async function saveState(statePath, nextState) {
  const payload = JSON.stringify(nextState, null, 2);
  await writeFile(statePath, payload, 'utf8');
}

async function appendLogEntry(logPath, entryLines) {
  const logExists = existsSync(logPath);
  const header = logExists ? '' : '# Export Log\n\n';
  await writeFile(logPath, `${header}${entryLines.join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'a',
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const envPath = resolveEnvPath(options.envPath);
  config({ path: envPath });

  const incremental = options.incremental || process.env.OBSIDIAN_EXPORT_INCREMENTAL === '1';
  const outDir = options.outDir || process.env.OBSIDIAN_EXPORT_DIR;
  if (!outDir) {
    throw new Error('Missing output folder. Use --out <folder> or set OBSIDIAN_EXPORT_DIR.');
  }

  const statePath = join(outDir, '.export-state.json');
  const previousState = await loadState(statePath);
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
  const logsDir = join(outDir, 'Logs');
  const dashboardsDir = join(outDir, 'Dashboards');
  const logPath = join(logsDir, 'Export Log.md');
  await mkdir(yearsDir, { recursive: true });
  await mkdir(issuesDir, { recursive: true });
  await mkdir(generationsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await mkdir(dashboardsDir, { recursive: true });

  const overviewPath = join(outDir, 'Overview.md');
  const overviewExists = existsSync(overviewPath);
  let overviewNeedsUpdate = !incremental || !overviewExists;
  const byAuthorPath = join(dashboardsDir, 'By Author.md');
  const byTagPath = join(dashboardsDir, 'By Tag.md');
  const recentExportsPath = join(dashboardsDir, 'Recent Exports.md');
  const dashboardsExist = existsSync(byAuthorPath) && existsSync(byTagPath) && existsSync(recentExportsPath);
  let dashboardsNeedUpdate = !incremental || !dashboardsExist;

  let totalNewGenerations = 0;
  let totalUpdatedIssues = 0;
  let totalUpdatedYears = 0;
  let lastGenerationFile = '';
  let lastGenerationId = '';

  const sortedYears = Object.entries(years).sort(([a], [b]) => a.localeCompare(b));
  for (const [year, issueList] of sortedYears) {
    console.log(`Processing year ${year} (${issueList.length} issues)...`);
    const yearPath = join(yearsDir, `${year}.md`);
    const yearExists = existsSync(yearPath);
    let yearNeedsUpdate = !incremental || !yearExists;

    let totalPagesForYear = 0;
    let newGenerationsForYear = 0;
    for (const issue of issueList) {
      const issueSlug = slugify(issue.title || issue.id);
      const issuePath = join(issuesDir, `${issueSlug}.md`);
      const issueExists = existsSync(issuePath);
      const issuePages = pagesByIssue.get(issue.id) || [];
      totalPagesForYear += issuePages.length;
      for (const page of issuePages) {
        page.ocr_generations = ocrByPage.get(page.id) || [];
      }
      const hasGenerations = issuePages.some((page) => page.ocr_generations.length > 0);
      let hasNewGenerations = false;

      for (const page of issuePages) {
        const generations = page.ocr_generations || [];
        for (const generation of generations) {
          const generationSlug = buildGenerationSlug(issue, page, generation);
          const generationPath = generationFilePath(generationsDir, generationSlug);
          if (incremental && existsSync(generationPath)) {
            continue;
          }
          const generationContent = buildGenerationNote(issue, page, generation);
          await writeFile(generationPath, generationContent, 'utf8');
          hasNewGenerations = true;
          newGenerationsForYear += 1;
          totalNewGenerations += 1;
          lastGenerationFile = `Generations/${generationSlug}.md`;
          lastGenerationId = String(generation.id || '');
        }
      }

      const shouldWriteIssue =
        !incremental ||
        (!issueExists && hasGenerations) ||
        hasNewGenerations;

      const stats = {
        totalPages: issuePages.length,
        pagesWithText: issuePages.filter((page) => page.ocr_text || page.status === 'completed').length,
        pagesWithGenerations: issuePages.filter((page) => (ocrByPage.get(page.id) || []).length > 0).length,
      };
      if (shouldWriteIssue) {
        const issueContent = buildIssueNote(issue, issuePages, stats);
        await writeFile(issuePath, issueContent, 'utf8');
        totalUpdatedIssues += 1;
      }
      if (!issueExists && shouldWriteIssue) {
        yearNeedsUpdate = true;
        overviewNeedsUpdate = true;
        dashboardsNeedUpdate = true;
      }
    }

    if (yearNeedsUpdate) {
      const yearContent = buildYearNote(year, issueList);
      await writeFile(yearPath, yearContent, 'utf8');
      totalUpdatedYears += 1;
    }

    console.log(
      `Finished year ${year}: ${issueList.length} issues, ${totalPagesForYear} pages, ${newGenerationsForYear} new generations.`
    );
  }

  if (overviewNeedsUpdate) {
    const overviewContent = buildOverview({ years, issues });
    await writeFile(overviewPath, overviewContent, 'utf8');
  }

  if (dashboardsNeedUpdate) {
    const authorAggregates = deriveAuthorAggregates(issues);
    const tagAggregates = deriveTagAggregates(issues);
    const recentIssues = sortIssuesByCreatedAt(issues);

    const authorContent = buildAuthorDashboard(authorAggregates);
    const tagContent = buildTagDashboard(tagAggregates);
    const recentContent = buildRecentExportsDashboard(recentIssues);

    await writeFile(byAuthorPath, authorContent, 'utf8');
    await writeFile(byTagPath, tagContent, 'utf8');
    await writeFile(recentExportsPath, recentContent, 'utf8');
  }

  const runTimestamp = new Date().toISOString();
  const logLines = [
    `## ${runTimestamp}`,
    `- imported: ${totalNewGenerations} new generations`,
    `- updated issues: ${totalUpdatedIssues}`,
    `- updated years: ${totalUpdatedYears}`,
    `- last file: ${lastGenerationFile || 'none'}`,
  ];
  await appendLogEntry(logPath, logLines);

  const nextState = {
    lastRunAt: runTimestamp,
    lastGenerationId: lastGenerationId || previousState.lastGenerationId || '',
    lastGenerationFile: lastGenerationFile || previousState.lastGenerationFile || '',
    totalNewGenerations,
  };
  await saveState(statePath, nextState);

  console.log(`Export complete. Wrote notes to ${outDir}`);
}

main().catch((err) => {
  console.error(`\nExport failed: ${err.message}`);
  process.exit(1);
});
