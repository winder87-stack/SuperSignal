#!/usr/bin/env node

/**
 * Script to extract all content from Hyperliquid GitBook documentation
 * https://hyperliquid.gitbook.io/hyperliquid-docs
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ExtractedPage {
    url: string;
    title: string;
    content: string;
    sections: Section[];
    codeBlocks: CodeBlock[];
    tables: Table[];
}

interface Section {
    level: number;
    title: string;
    content: string;
}

interface CodeBlock {
    language: string;
    code: string;
}

interface Table {
    headers: string[];
    rows: string[][];
}

interface ExtractedDocs {
    baseUrl: string;
    extractedAt: string;
    pages: ExtractedPage[];
    navigation: NavigationItem[];
}

interface NavigationItem {
    title: string;
    url: string;
    children?: NavigationItem[];
}

const BASE_URL = 'https://hyperliquid.gitbook.io/hyperliquid-docs';
const OUTPUT_FILE = path.join(__dirname, '..', 'hyperliquid-docs-extracted.json');

// Set of visited URLs to avoid duplicates
const visitedUrls = new Set<string>();
const allPages: ExtractedPage[] = [];
const navigation: NavigationItem[] = [];

/**
 * Fetch HTML content from a URL
 */
function fetchUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        protocol.get(url, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                resolve(data);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Extract text content from HTML
 */
function extractTextFromHtml(html: string): string {
    // Remove script and style tags
    let text = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gm, '');
    text = text.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gm, '');

    // Remove HTML tags but keep content
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&/g, '&');
    text = text.replace(/</g, '<');
    text = text.replace(/>/g, '>');
    text = text.replace(/"/g, '"');
    text = text.replace(/'/g, "'");

    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();

    return text;
}

/**
 * Extract sections (headings) from HTML
 */
function extractSections(html: string): Section[] {
    const sections: Section[] = [];

    // Match heading tags h1-h6
    const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi;
    let match;
    let lastIndex = 0;

    while ((match = headingRegex.exec(html)) !== null) {
        const level = parseInt(match[1]);
        const title = extractTextFromHtml(match[2]);

        // Get content after this heading until next heading
        const contentStart = headingRegex.lastIndex;
        const nextHeadingMatch = headingRegex.exec(html);

        let content = '';
        if (nextHeadingMatch) {
            content = html.substring(contentStart, nextHeadingMatch.index);
            headingRegex.lastIndex = nextHeadingMatch.index; // Reset for next iteration
        } else {
            content = html.substring(contentStart);
        }

        sections.push({
            level,
            title,
            content: extractTextFromHtml(content)
        });
    }

    return sections;
}

/**
 * Extract code blocks from HTML
 */
function extractCodeBlocks(html: string): CodeBlock[] {
    const codeBlocks: CodeBlock[] = [];

    // Match pre/code blocks
    const codeRegex = /<pre[^>]*><code[^>]*class="language-(\w+)"[^>]*>([\s\S]*?)<\/code><\/pre>/gi;
    let match;

    while ((match = codeRegex.exec(html)) !== null) {
        const language = match[1];
        const code = match[2]
            .replace(/</g, '<')
            .replace(/>/g, '>')
            .replace(/&/g, '&')
            .replace(/"/g, '"')
            .replace(/'/g, "'")
            .trim();

        codeBlocks.push({ language, code });
    }

    return codeBlocks;
}

/**
 * Extract tables from HTML
 */
function extractTables(html: string): Table[] {
    const tables: Table[] = [];

    // Match table elements
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let match;

    while ((match = tableRegex.exec(html)) !== null) {
        const tableHtml = match[1];

        // Extract headers
        const headerMatch = tableHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
        const headers: string[] = [];

        if (headerMatch) {
            const thRegex = /<th[^>]*>(.*?)<\/th>/gi;
            let thMatch;
            while ((thMatch = thRegex.exec(headerMatch[1])) !== null) {
                headers.push(extractTextFromHtml(thMatch[1]));
            }
        }

        // Extract rows
        const rows: string[][] = [];
        const tbodyMatch = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
        const rowHtml = tbodyMatch ? tbodyMatch[1] : tableHtml;

        const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let trMatch;
        while ((trMatch = trRegex.exec(rowHtml)) !== null) {
            const row: string[] = [];
            const tdRegex = /<t[dh][^>]*>(.*?)<\/t[dh]>/gi;
            let tdMatch;
            while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
                row.push(extractTextFromHtml(tdMatch[1]));
            }
            if (row.length > 0) {
                rows.push(row);
            }
        }

        if (headers.length > 0 || rows.length > 0) {
            tables.push({ headers, rows });
        }
    }

    return tables;
}

/**
 * Extract navigation links from HTML
 */
function extractNavigation(html: string): NavigationItem[] {
    const items: NavigationItem[] = [];

    // GitBook typically uses specific classes for navigation
    // Try to find navigation links
    const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
    const seenUrls = new Set<string>();

    let match;
    while ((match = linkRegex.exec(html)) !== null) {
        let url = match[1];
        const title = extractTextFromHtml(match[2]);

        // Clean up URL
        if (url.startsWith('/')) {
            url = 'https://hyperliquid.gitbook.io' + url;
        }

        // Only include documentation links
        if (url.includes('hyperliquid.gitbook.io/hyperliquid-docs') &&
            !seenUrls.has(url) &&
            title.length > 0 &&
            title.length < 100) {
            seenUrls.add(url);
            items.push({ title, url });
        }
    }

    return items;
}

/**
 * Extract page content
 */
async function extractPage(url: string): Promise<ExtractedPage | null> {
    try {
        console.log(`Fetching: ${url}`);
        const html = await fetchUrl(url);

        // Extract title
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const title = titleMatch ? extractTextFromHtml(titleMatch[1]) : 'Untitled';

        // Extract main content area
        // GitBook typically uses specific classes for content
        let contentHtml = html;

        // Try to find the main content area
        const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
            html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
            html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

        if (contentMatch) {
            contentHtml = contentMatch[1];
        }

        const content = extractTextFromHtml(contentHtml);
        const sections = extractSections(contentHtml);
        const codeBlocks = extractCodeBlocks(contentHtml);
        const tables = extractTables(contentHtml);

        return {
            url,
            title,
            content,
            sections,
            codeBlocks,
            tables
        };
    } catch (error) {
        console.error(`Error fetching ${url}:`, error);
        return null;
    }
}

/**
 * Discover all documentation pages
 */
async function discoverPages(startUrl: string): Promise<string[]> {
    const discoveredUrls = new Set<string>();
    const queue: string[] = [startUrl];

    while (queue.length > 0) {
        const url = queue.shift()!;

        if (discoveredUrls.has(url)) {
            continue;
        }

        discoveredUrls.add(url);

        try {
            const html = await fetchUrl(url);
            const links = extractNavigation(html);

            for (const link of links) {
                if (!discoveredUrls.has(link.url) && !queue.includes(link.url)) {
                    queue.push(link.url);
                }
            }
        } catch (error) {
            console.error(`Error discovering pages from ${url}:`, error);
        }
    }

    return Array.from(discoveredUrls);
}

/**
 * Main extraction function
 */
async function extractDocumentation() {
    console.log('Starting Hyperliquid documentation extraction...');
    console.log(`Base URL: ${BASE_URL}`);

    // Discover all pages
    console.log('\nDiscovering all documentation pages...');
    const allUrls = await discoverPages(BASE_URL);
    console.log(`Found ${allUrls.length} pages to extract`);

    // Extract content from each page
    console.log('\nExtracting content from all pages...');
    for (const url of allUrls) {
        if (visitedUrls.has(url)) {
            continue;
        }

        visitedUrls.add(url);
        const page = await extractPage(url);

        if (page) {
            allPages.push(page);
        }

        // Small delay to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Build navigation structure
    console.log('\nBuilding navigation structure...');
    const mainPageHtml = await fetchUrl(BASE_URL);
    navigation.push(...extractNavigation(mainPageHtml));

    // Create output object
    const extractedDocs: ExtractedDocs = {
        baseUrl: BASE_URL,
        extractedAt: new Date().toISOString(),
        pages: allPages,
        navigation
    };

    // Save to JSON file
    console.log(`\nSaving extracted data to ${OUTPUT_FILE}...`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(extractedDocs, null, 2), 'utf-8');

    console.log('\nExtraction complete!');
    console.log(`Total pages extracted: ${allPages.length}`);
    console.log(`Total sections: ${allPages.reduce((sum, p) => sum + p.sections.length, 0)}`);
    console.log(`Total code blocks: ${allPages.reduce((sum, p) => sum + p.codeBlocks.length, 0)}`);
    console.log(`Total tables: ${allPages.reduce((sum, p) => sum + p.tables.length, 0)}`);
}

// Run the extraction
extractDocumentation().catch(console.error);
