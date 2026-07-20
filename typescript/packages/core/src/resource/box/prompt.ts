// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

export const BOX_PROMPT = `{prefix}
  Mirrors Box folder hierarchy. Every item is served as its raw bytes:
    <name>.boxnote      Box Note    (raw ProseMirror-style JSON; pipe to jq)
    <name>.boxcanvas    Box Canvas  (raw canvas JSON; pipe to jq)
    <name>.gdoc/.gsheet/.gslides  Box's Google-Workspace files, stored as
                        Office Open XML (docx/xlsx/pptx) - opaque binary
    <other-files>       PDFs, images, parquet, etc. - raw bytes

  IMPORTANT: This is a remote mount. Prefer targeted reads over full scans.
  Box uses numeric folder IDs internally (root = 0); mirage caches the
  path -> id mapping, so nested dirs cost one API call per level on first
  access. Use ls on the parent dir before constructing a path.`
