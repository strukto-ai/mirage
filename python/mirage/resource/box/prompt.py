# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

PROMPT = """{prefix}
  Mirrors Box folder hierarchy. May contain:
    <name>.boxnote.json     Box Note            (cat returns boxnote.json shape)
    <name>.boxcanvas.json   Box Canvas          (cat returns boxcanvas.json shape)
    <name>.gdoc.json        Box's Google Doc    (cat returns box-office.json shape)
    <name>.gsheet.json      Box's Google Sheet  (cat returns box-office.json shape)
    <name>.gslides.json     Box's Google Slides (cat returns box-office.json shape)
    <other-files>           PDFs, images, parquet, etc. - cat returns raw bytes

  IMPORTANT: This is a remote mount. Prefer targeted reads over full scans.
  Box uses numeric folder IDs internally (root = 0); mirage caches the
  path -> id mapping, so nested dirs cost one API call per level on first
  access. Use ls on the parent dir before constructing a path.

  JSON shapes returned by cat for the special file types:

  boxnote.json {
    "id":           "...",
    "body_text":    "paragraphs joined by \\n",
    "paragraphs":   [ { "text": "...", "authors": ["..."] } ],
    "authors":      { "<id>": "Author Name" },
    "last_edit_at": "..."
  }

  boxcanvas.json {
    "id":              "...",
    "widget_count":    ...,
    "widgets_by_type": { "shape": ..., "link": ... },
    "body_text":       "shape labels joined by \\n",
    "widgets":         [ { "id": "...", "type": "shape", "text": "..." } ],
    "authors":         [ "..." ]
  }

  box-office.json {
    "id":          "...",
    "name":        "...",
    "format":      "docx" | "xlsx" | "pptx",
    "size":        ...,
    "modified_at": "...",
    "body_text":   "auto-extracted plain text"
  }

  For plain text from any of these: cat <path> | jq -r .body_text"""
