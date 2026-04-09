# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Mindmap task tracker with a Node.js/Express backend and HTML frontend. Data is stored **date-wise** — each date gets its own JSON file on the server (`data/YYYY-MM-DD.json`).

Architecture: horizontal left-to-right mindmap. Root node (project) -> Sections -> Tasks. Frontend communicates with backend REST API for persistence.

## Project structure

```
server.js          — Express backend, serves API + static files
public/index.html  — Mindmap frontend (single-file HTML/CSS/JS)
data/              — Date-wise JSON storage (one file per date)
package.json       — Dependencies: express, cors
```

## Development

```bash
npm install        # first time
npm start          # starts server at http://localhost:3000
```

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dates` | List all dates with saved data |
| GET | `/api/data/:date` | Load data for a date (YYYY-MM-DD) |
| POST | `/api/data/:date` | Save data for a date |
| DELETE | `/api/data/:date` | Delete data for a date |
| GET | `/api/export` | Export all dates as single JSON |

## Critical implementation rules

These exist because of real bugs found during development. **Always follow them.**

### Never use `confirm()` or `alert()`

Chrome silently blocks `confirm()` on `file://` — it returns `false` immediately with no UI. **Always use the shared modal** (`#modal-overlay`) for confirmations. Delete modals must show the item name and a red "Delete" button.

### Reset modal button after close

The confirm button turns red for deletes. Always reset it when closing:

```js
function resetModalBtn() {
  const btn = document.getElementById('modal-confirm');
  if (btn) { btn.textContent = 'Save'; btn.className = 'btn btn-primary'; }
}
```

### All functions must be on `window`

HTML rendered via `innerHTML` uses `onclick` attributes that only resolve global-scope functions. Use `function` declarations (not `const`/arrow), or explicitly assign to `window`.

### IDs must be stable

Use a random `uid()` function — never use array index as an ID. Indices change on reorder/delete.

### After every state mutation

Call `render()` and `save()`. Show a toast for every user action (create, update, delete, reorder, export).

## Data structure

```json
{
  "rootTitle": "My Project",
  "modules": [
    {
      "id": "_abc123",
      "label": "Section name",
      "status": "done",
      "kids": [
        { "id": "_def456", "label": "Task name", "status": "pending" }
      ]
    }
  ]
}
```

Status values: `"done"` | `"testing"` | `"pending"`

This is the export/import format.

## UI architecture

- **Single shared modal** (`#modal-overlay`) for all add/edit/delete operations. Mode tracked via `modalMode` variable.
- **Sticky header** (`z-index: 100`) with app title, search bar, Add Section and Export buttons.
- **URL panel** below header showing local/public URLs with copy buttons.
- **Stats bar** (`#stats-bar`) and **progress bar** (`#progress-wrap`) re-rendered on every `render()` call.
- **Root node** (`.root-node`) — click to rename project; shows mini progress bar.
- **Section cards** (`.branch-card`) — hover reveals drag handle + edit/delete icons. Chevron for expand/collapse.
- **Task rows** (`.leaf-row`) — hover reveals edit/delete icons.
- **Toast** (`#toast`) — bottom-right, auto-hides after 2.4s.

## CSS variables

```css
--accent: #2d6a4f;       --done-text: #1a6b3c;
--testing-text: #1a4a8a; --pending-text: #8a5a00;
--danger: #c0392b;       --surface: #ffffff;
--surface2: #f0efe9;     --bg: #f7f6f3;
```

## Extension features (available on request)

Import JSON, notes field, due dates, priority levels, dark mode, print/PDF, collapse all, keyboard shortcuts, multi-level nesting. See git history for the base prompt and extension prompt templates.
