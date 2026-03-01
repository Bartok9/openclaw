---
name: nano-pdf
description: Edit PDFs with natural-language instructions using the nano-pdf CLI. Use when users need to modify text, fix typos, update content, or make visual changes to PDF documents without manual editing.
homepage: https://pypi.org/project/nano-pdf/
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "requires": { "bins": ["nano-pdf"] },
        "install":
          [
            {
              "id": "uv",
              "kind": "uv",
              "package": "nano-pdf",
              "bins": ["nano-pdf"],
              "label": "Install nano-pdf (uv)",
            },
            {
              "id": "pip",
              "kind": "pip",
              "package": "nano-pdf",
              "bins": ["nano-pdf"],
              "label": "Install nano-pdf (pip)",
            },
          ],
      },
  }
---

# nano-pdf

Edit PDFs with natural-language instructions. No need for specialized PDF editing software.

## When to Use

✅ **USE this skill when:**
- Fixing typos or updating text in a PDF
- Changing titles, headers, or labels
- Updating dates, numbers, or names
- Making quick text corrections

❌ **DON'T use when:**
- Complex layout changes are needed (use a full PDF editor)
- Adding/removing pages (use other PDF tools)
- Working with scanned/image-based PDFs (need OCR first)

## Commands

### Edit a specific page

```bash
nano-pdf edit <file.pdf> <page> "<instruction>"
```

### Examples

```bash
# Fix a typo on page 1
nano-pdf edit report.pdf 1 "Change 'recieved' to 'received'"

# Update a title
nano-pdf edit deck.pdf 1 "Change the title to 'Q3 Results'"

# Update multiple items
nano-pdf edit invoice.pdf 1 "Change the date to January 15, 2026 and update the total to $1,500"

# Fix formatting
nano-pdf edit memo.pdf 2 "Make the heading bold and center it"
```

## Important Notes

- **Page numbering**: May be 0-based or 1-based depending on version. If results are off by one, try the other.
- **Output file**: Creates a new file (doesn't overwrite original by default)
- **Always verify**: Review the output PDF before sharing or printing
- **Text-based PDFs**: Works best with PDFs that have actual text (not scanned images)
