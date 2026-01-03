#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const tempDir = 'temp_docs';
const baseUrl = 'https://hyperliquid.gitbook.io/hyperliquid-docs';

// Read all HTML files
const pages = [];
const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.html'));

for (const filename of files) {
    const filepath = path.join(tempDir, filename);
    const html = fs.readFileSync(filepath, 'utf-8');
    const $ = cheerio.load(html);

    // Reconstruct URL from filename
    const pageName = filename.replace('.html', '');
    const url = pageName === 'index' ? baseUrl : `${baseUrl}/${pageName.replace(/_/g, '/')}`;

    // Extract title
    const title = $('title').text().trim() || 'Untitled';

    // Extract content (remove scripts and styles)
    $('script, style').remove();
    const content = $('body').text().replace(/\s+/g, ' ').trim();

    // Extract sections (headings)
    const sections = [];
    $('h1, h2, h3, h4, h5, h6').each((i, el) => {
        const level = parseInt(el.tagName.charAt(1));
        const title = $(el).text().trim();
        sections.push({ level, title });
    });

    // Extract code blocks
    const codeBlocks = [];
    $('pre code').each((i, el) => {
        const $el = $(el);
        const classList = $el.attr('class') || '';
        const languageMatch = classList.match(/language-(\w+)/);
        const language = languageMatch ? languageMatch[1] : 'unknown';
        const code = $el.text().trim();
        codeBlocks.push({ language, code });
    });

    // Extract tables
    const tables = [];
    $('table').each((i, el) => {
        const $table = $(el);
        const headers = [];
        const rows = [];

        $table.find('thead th').each((j, th) => {
            headers.push($(th).text().trim());
        });

        $table.find('tbody tr').each((j, tr) => {
            const row = [];
            $(tr).find('td, th').each((k, cell) => {
                row.push($(cell).text().trim());
            });
            if (row.length > 0) {
                rows.push(row);
            }
        });

        if (headers.length > 0 || rows.length > 0) {
            tables.push({ headers, rows });
        }
    });

    pages.push({
        url,
        title,
        content,
        sections,
        codeBlocks,
        tables
    });
}

// Create output
const output = {
    baseUrl,
    extractedAt: new Date().toISOString(),
    pages,
    totalPages: pages.length
};

// Write to JSON file
fs.writeFileSync('hyperliquid-docs-extracted.json', JSON.stringify(output, null, 2), 'utf-8');

console.log(`JSON output created with ${pages.length} pages`);
