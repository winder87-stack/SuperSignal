#!/usr/bin/env python3
import json
import os
import re
from datetime import datetime
from html.parser import HTMLParser

class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.text = []
        self.in_script = False
        self.in_style = False
    
    def handle_starttag(self, tag, attrs):
        if tag in ["script", "style"]:
            if tag == "script":
                self.in_script = True
            elif tag == "style":
                self.in_style = True
    
    def handle_endtag(self, tag):
        if tag == "script":
            self.in_script = False
        elif tag == "style":
            self.in_style = False
    
    def handle_data(self, data):
        if not self.in_script and not self.in_style:
            self.text.append(data)
    
    def get_text(self):
        return " ".join(self.text).strip()

def extract_sections(html):
    sections = []
    heading_pattern = r"<h([1-6])[^>]*>(.*?)</h>"
    
    for match in re.finditer(heading_pattern, html, re.IGNORECASE | re.DOTALL):
        level = int(match.group(1))
        title = re.sub(r"<[^>]+>", "", match.group(2)).strip()
        sections.append({
            "level": level,
            "title": title
        })
    
    return sections

def extract_code_blocks(html):
    code_blocks = []
    code_pattern = r'<pre[^>]*><code[^>]*class="language-(\w+)"[^>]*>(.*?)</code></pre>'
    
    for match in re.finditer(code_pattern, html, re.IGNORECASE | re.DOTALL):
        language = match.group(1)
        code = match.group(2)
        # Decode HTML entities
        code = code.replace("<", "<").replace(">", ">").replace("&", "&")
        code = code.replace(""", '"').replace("'", "'").strip()
        code_blocks.append({
            "language": language,
            "code": code
        })
    
    return code_blocks

def extract_tables(html):
    tables = []
    table_pattern = r"<table[^>]*>(.*?)</table>"
    
    for match in re.finditer(table_pattern, html, re.IGNORECASE | re.DOTALL):
        table_html = match.group(1)
        
        # Extract headers
        headers = []
        header_match = re.search(r"<thead[^>]*>(.*?)</thead>", table_html, re.IGNORECASE | re.DOTALL)
        if header_match:
            for th_match in re.finditer(r"<th[^>]*>(.*?)</th>", header_match.group(1), re.IGNORECASE):
                header_text = re.sub(r"<[^>]+>", "", th_match.group(1)).strip()
                headers.append(header_text)
        
        # Extract rows
        rows = []
        tbody_match = re.search(r"<tbody[^>]*>(.*?)</tbody>", table_html, re.IGNORECASE | re.DOTALL)
        row_html = tbody_match.group(1) if tbody_match else table_html
        
        for tr_match in re.finditer(r"<tr[^>]*>(.*?)</tr>", row_html, re.IGNORECASE | re.DOTALL):
            row = []
            for td_match in re.finditer(r"<t[dh][^>]*>(.*?)</t[dh]>", tr_match.group(1), re.IGNORECASE):
                cell_text = re.sub(r"<[^>]+>", "", td_match.group(1)).strip()
                row.append(cell_text)
            if row:
                rows.append(row)
        
        if headers or rows:
            tables.append({
                "headers": headers,
                "rows": rows
            })
    
    return tables

def extract_title(html):
    title_match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE)
    if title_match:
        return re.sub(r"<[^>]+>", "", title_match.group(1)).strip()
    return "Untitled"

def extract_content(html):
    parser = TextExtractor()
    parser.feed(html)
    return parser.get_text()

# Process all HTML files
pages = []
temp_dir = "temp_docs"
base_url = "https://hyperliquid.gitbook.io/hyperliquid-docs"

for filename in os.listdir(temp_dir):
    if filename.endswith(".html"):
        filepath = os.path.join(temp_dir, filename)
        
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            html = f.read()
        
        # Reconstruct URL from filename
        page_name = filename[:-5]  # Remove .html
        if page_name == "index":
            url = base_url
        else:
            url = f"{base_url}/{page_name.replace('_', '/')}"
        
        title = extract_title(html)
        content = extract_content(html)
        sections = extract_sections(html)
        code_blocks = extract_code_blocks(html)
        tables = extract_tables(html)
        
        pages.append({
            "url": url,
            "title": title,
            "content": content,
            "sections": sections,
            "codeBlocks": code_blocks,
            "tables": tables
        })

# Create output
output = {
    "baseUrl": base_url,
    "extractedAt": datetime.utcnow().isoformat() + "Z",
    "pages": pages,
    "totalPages": len(pages)
}

# Write to JSON file
with open("hyperliquid-docs-extracted.json", "w", encoding="utf-8") as f:
    json.dump(output, f, indent=2, ensure_ascii=False)

print(f"JSON output created with {len(pages)} pages")
