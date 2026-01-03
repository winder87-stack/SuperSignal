#!/bin/bash

# Script to extract all content from Hyperliquid GitBook documentation
# https://hyperliquid.gitbook.io/hyperliquid-docs

BASE_URL="https://hyperliquid.gitbook.io/hyperliquid-docs"
OUTPUT_FILE="hyperliquid-docs-extracted.json"
TEMP_DIR="temp_docs"

# Create temp directory
mkdir -p "$TEMP_DIR"

echo "Starting Hyperliquid documentation extraction..."
echo "Base URL: $BASE_URL"

# Function to fetch a page
fetch_page() {
    local url="$1"
    local filename="$2"
    echo "Fetching: $url"
    curl -s -L -A "Mozilla/5.0" "$url" -o "$filename"
}

# Fetch all URLs from sitemap
echo "Fetching sitemap..."
curl -s -L -A "Mozilla/5.0" "${BASE_URL}/sitemap-pages.xml" | \
    grep -oP '<loc>\K[^<]+' > "$TEMP_DIR/links.txt"

# Count unique links
link_count=$(wc -l < "$TEMP_DIR/links.txt")
echo "Found $link_count unique pages to extract"

# Fetch all pages
echo "Fetching all pages..."
counter=0
while IFS= read -r url; do
    if [ -n "$url" ]; then
        # Create a safe filename from the URL
        filename=$(echo "$url" | sed 's|https://hyperliquid.gitbook.io/hyperliquid-docs/||' | sed 's|/|_|g' | sed 's|?|_|g')
        if [ -z "$filename" ]; then
            filename="index"
        fi
        
        fetch_page "$url" "$TEMP_DIR/${filename}.html"
        counter=$((counter + 1))
        
        # Small delay to avoid overwhelming the server
        sleep 0.3
    fi
done < "$TEMP_DIR/links.txt"

echo "Fetched $counter pages"

# Create JSON output using Node.js
echo "Creating JSON output..."
node scripts/process-docs.js

# Clean up
echo "Cleaning up temporary files..."
rm -rf "$TEMP_DIR"

echo "Extraction complete!"
echo "Output saved to: $OUTPUT_FILE"
echo "Total pages extracted: $counter"
