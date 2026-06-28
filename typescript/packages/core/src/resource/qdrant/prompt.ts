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

export const QDRANT_PROMPT = `This mount is a Qdrant vector database exposed as a filesystem.

At the root each directory is a collection (unless a single collection is pinned
in config). Inside a collection, directories are the configured group-by payload
fields; descending narrows a filter. Each matching point appears as files named
by its id: <id>.json (the full payload), <id>.txt (the embedded source text)
when a text field is configured, and <id>.<ext> (raw blob bytes) when a blob
field is configured, where <id> is the Qdrant point id. The embedding vector is
never shown. For semantic search use the search command, which returns ranked
points as their content file paths with a similarity score, e.g.
search "red running shoes" /mount then cat one of the returned files.
Use ls/cd/cat/tree/find/wc as usual; grep/rg stay lexical. Quote queries that
contain spaces.`
