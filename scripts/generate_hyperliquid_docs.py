#!/usr/bin/env python3
"""
Hyperliquid Documentation Generator
Generates comprehensive Markdown documentation from extracted JSON data.
"""

import json
import re
from pathlib import Path
from typing import Dict, List, Any
from collections import defaultdict

def clean_content(content: str) -> str:
    """Clean content by removing navigation elements and extra whitespace."""
    # Remove navigation menu items
    content = re.sub(r'Hyperliquid DocsCtrlk.*?Powered by GitBook', '', content)
    # Remove "On this pageCopy" and similar artifacts
    content = re.sub(r'On this pageCopy', '', content)
    # Remove "Previous" and "Next" navigation links
    content = re.sub(r'Previous.*?Next.*', '', content)
    # Clean up multiple newlines
    content = re.sub(r'\n{3,}', '\n\n', content)
    return content.strip()

def get_section_from_url(url: str) -> str:
    """Extract section name from URL."""
    parts = url.split('/')
    if len(parts) >= 2:
        section = parts[-1]
        # Convert kebab-case to title case
        return ' '.join(word.capitalize() for word in section.replace('-', ' ').split(' '))
    return 'Unknown'

def get_page_category(url: str) -> str:
    """Categorize page based on URL path."""
    if '/about-hyperliquid/' in url:
        return 'About Hyperliquid'
    elif '/onboarding/' in url:
        return 'Onboarding'
    elif '/hypercore/' in url:
        return 'HyperCore'
    elif '/hyperevm/' in url:
        return 'HyperEVM'
    elif '/trading/' in url:
        return 'Trading'
    elif '/validators/' in url:
        return 'Validators'
    elif '/for-developers/api/' in url:
        return 'API Documentation'
    elif '/for-developers/hyperevm/' in url:
        return 'HyperEVM for Developers'
    elif '/for-developers/nodes' in url:
        return 'Nodes'
    elif '/historical-data/' in url:
        return 'Historical Data'
    elif '/risks/' in url:
        return 'Risks'
    elif '/referrals/' in url:
        return 'Referrals'
    elif '/points/' in url:
        return 'Points'
    elif '/bug-bounty-program/' in url:
        return 'Bug Bounty Program'
    elif '/audits/' in url:
        return 'Audits'
    elif '/brand-kit/' in url:
        return 'Brand Kit'
    elif '/hyperliquid-improvement-proposals-' in url:
        return 'Hyperliquid Improvement Proposals (HIPs)'
    else:
        return 'Other'

def format_code_block(code: str, language: str = 'unknown') -> str:
    """Format code block with proper Markdown syntax."""
    return f"```{language}\n{code}\n```"

def format_table(headers: List[str], rows: List[List[str]]) -> str:
    """Format a Markdown table."""
    if not headers or not rows:
        return ""
    
    # Calculate column widths by iterating through each column position
    if headers:
        num_cols = len(headers)
        col_widths = []
        for col_idx in range(num_cols):
            max_len = 0
            for row in rows:
                if col_idx < len(row):
                    cell_len = len(str(row[col_idx]))
                    if cell_len > max_len:
                        max_len = cell_len
            col_widths.append(max_len)
    else:
        col_widths = []
    
    # Build separator line
    separator = "| " + "|".join("-" * w for w in col_widths) + " |"
    
    # Build header row
    header_row = "| " + "|".join(str(cell).ljust(w) for cell, w in zip(headers, col_widths)) + " |"
    
    # Build data rows
    data_rows = []
    for row in rows:
        cells = []
        for col_idx in range(len(col_widths)):
            if col_idx < len(row):
                cells.append(str(row[col_idx]).ljust(col_widths[col_idx]))
            else:
                cells.append("")
        data_row = "| " + "|".join(cells) + " |"
        data_rows.append(data_row)
    
    return "\n".join([header_row, separator] + data_rows) + "\n"

def generate_toc(pages: List[Dict[str, Any]]) -> str:
    """Generate Table of Contents from pages."""
    toc_lines = ["# Table of Contents\n"]
    
    # Group pages by category
    categories = defaultdict(list)
    for page in pages:
        category = get_page_category(page['url'])
        categories[category].append(page)
    
    # Generate TOC entries
    for category, pages_list in sorted(categories.items()):
        if category == 'Other':
            continue
        toc_lines.append(f"\n## {category}\n")
        for page in sorted(pages_list, key=lambda p: p['title']):
            title = page['title'].replace(' | Hyperliquid Docs', '').strip()
            toc_lines.append(f"- [{title}](#{title.lower().replace(' ', '-')})")
    
    return "\n".join(toc_lines)

def process_page(page: Dict[str, Any]) -> str:
    """Process a single page into Markdown format."""
    content = clean_content(page.get('content', ''))
    url = page.get('url', '')
    title = page.get('title', '').replace(' | Hyperliquid Docs', '').strip()
    
    md_lines = []
    
    # Add main heading
    md_lines.append(f"\n# {title}\n")
    
    # Add sections if available
    sections = page.get('sections', [])
    if sections:
        for section in sections:
            level = section.get('level', 2)
            section_title = section.get('title', '')
            prefix = '#' * level
            md_lines.append(f"\n{prefix} {section_title}\n")
    
    # Add content
    if content:
        md_lines.append(f"\n{content}\n")
    
    # Add code blocks
    code_blocks = page.get('codeBlocks', [])
    for i, code_block in enumerate(code_blocks, 1):
        code = code_block.get('code', '')
        language = code_block.get('language', 'unknown')
        md_lines.append(f"\n```{language}\n{code}\n```\n")
    
    # Add tables
    tables = page.get('tables', [])
    for table in tables:
        if table.get('headers') and table.get('rows'):
            md_lines.append(format_table(table['headers'], table['rows']))
    
    return "\n".join(md_lines)

def generate_documentation(data: Dict[str, Any]) -> str:
    """Generate complete Markdown documentation."""
    pages = data.get('pages', [])
    
    md_lines = []
    
    # Document header
    md_lines.append("# Hyperliquid Complete Documentation\n")
    md_lines.append("\n> Extracted from https://hyperliquid.gitbook.io/hyperliquid-docs\n")
    md_lines.append(f"\n> Extracted at: {data.get('extractedAt', 'Unknown')}\n")
    md_lines.append(f"\n> Total pages: {len(pages)}\n")
    md_lines.append("\n---\n")
    
    # Table of Contents
    md_lines.append(generate_toc(pages))
    md_lines.append("\n---\n")
    
    # Process pages by category
    categories = defaultdict(list)
    for page in pages:
        category = get_page_category(page['url'])
        categories[category].append(page)
    
    # Generate content for each category
    for category, pages_list in sorted(categories.items()):
        if category == 'Other':
            continue
        
        md_lines.append(f"\n## {category}\n")
        
        for page in sorted(pages_list, key=lambda p: p['title']):
            title = page['title'].replace(' | Hyperliquid Docs', '').strip()
            url = page.get('url', '')
            
            md_lines.append(f"\n### {title}\n")
            md_lines.append(f"\n**Source:** {url}\n")
            
            # Process page content
            page_content = process_page(page)
            md_lines.append(page_content)
            
            md_lines.append("\n---\n")
    
    # Add footer
    md_lines.append("\n---\n")
    md_lines.append("\n*Documentation generated from extracted data*\n")
    md_lines.append("*All content preserved from original source*\n")
    
    return "\n".join(md_lines)

def main():
    """Main function to generate documentation."""
    # Read JSON file
    json_path = Path(__file__).parent.parent / 'hyperliquid-docs-extracted.json'
    
    print(f"Reading {json_path}...")
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    print(f"Processing {len(data.get('pages', []))} pages...")
    
    # Generate documentation
    documentation = generate_documentation(data)
    
    # Write to output file
    output_path = Path(__file__).parent / 'HYPERLIQUID-COMPLETE-DOCUMENTATION.md'
    print(f"Writing documentation to {output_path}...")
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(documentation)
    
    print(f"Documentation generated successfully!")
    print(f"Total characters: {len(documentation)}")
    print(f"Output file: {output_path}")

if __name__ == '__main__':
    main()
