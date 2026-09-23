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

export const DIFY_PROMPT = `This is a Dify Knowledge Base mounted as a read-only filesystem.

All files are plain text assembled from Dify document segments, regardless of
their original extension. You can use cat, head, tail, grep, find, ls, wc, and
search on these files.

For semantic or relevance-based queries, use:

search "<query>" [path ...] [--method semantic|fulltext|hybrid|keyword] [--top-k N] [--threshold F]

Use grep for exact pattern or regex matching; use search when meaning matters.
Search can target multiple files, folders, or globs. Each result is returned as
an absolute workspace path, optionally followed by the Dify relevance score,
then the matched chunk content. Multiple hits from the same document stay as
separate results.

Scoped search requires documents with the configured slug metadata field
(default: slug) or Dify Built-in Fields enabled for name-based documents.
Otherwise, scoped searches against name-based paths may return empty results.`
