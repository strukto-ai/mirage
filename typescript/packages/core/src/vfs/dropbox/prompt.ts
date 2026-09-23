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

export const DROPBOX_PROMPT = `{prefix}
  Mirrors Dropbox folder hierarchy. Each entry is a real file or folder
  (no special document types — Dropbox stores opaque files).
    <name>/             folder
    <name>.<ext>        file (cat returns raw bytes)

  IMPORTANT: This is a remote mount. Prefer targeted reads over full scans.
  Use ls on the parent dir first; don't construct paths from memory.

  Available commands (use ONLY these; do not invent commands like \`readFile\`):
    Filesystem: ls, cat, head, tail, nl, wc, stat, find, tree, grep, rg,
                jq, awk, sed, sort, uniq, cut, diff, cmp, du, file,
                base64, basename, dirname, realpath`
