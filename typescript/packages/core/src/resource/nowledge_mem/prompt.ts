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

export const NOWLEDGE_MEM_PROMPT = `{prefix}
  Nowledge Mem is a remote knowledge filesystem, not just a memory list.
  Start with ls {prefix} to discover the tree: memories, threads, sources, wiki,
  context, working-memory, feed, artifacts, and skills. Prefer targeted reads:
  use recall for fuzzy memory questions, find for metadata filters, grep for
  exact phrases across memories, threads, and parsed Library sources, stat
  before loading large files, and cat --line/--lines when you only need an
  evidence window. Treat paths as Nowledge FS identifiers, not local OS paths.
  This mount talks directly to the Nowledge Mem /fs/* API and does not require
  the nmem CLI.
`.trim()
