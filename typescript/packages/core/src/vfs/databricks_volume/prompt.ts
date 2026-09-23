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

export const DATABRICKS_VOLUME_PROMPT = `{prefix}
  Remote Databricks Unity Catalog volume filesystem.
  IMPORTANT: This is a remote mount - every file/dir access is an API round-trip.
  Prefer targeted reads (ls, head, grep, rg, find with a path/glob) over full
  scans; recursive ops (rm -r, cp -r, tree, grep -r) over a large tree are slow.
  Create parent dirs before writing: \`mkdir -p /path && cmd > /path/out\`.
  mv/cp are non-atomic full copies (no server-side rename) - avoid on large files.
  sed -i is not supported; transform and redirect to a new file instead.
  Read/analyze: ls, cat, head, tail, grep, rg, find, tree, stat, wc, sort, uniq,
    cut, nl, tr, sed, awk, jq, diff.
  Write: touch, rm, rm -r, mkdir, mkdir -p, cp, mv, and >/>> redirects.`
