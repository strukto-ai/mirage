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

PROMPT = """\
This mount is a Qdrant vector database exposed as a filesystem.

Layout:
- At the root, each directory is a Qdrant collection (unless a single collection
  is pinned in config).
- Inside a collection, directories are the configured group-by payload fields.
  Descending narrows a filter, e.g. `ls products/Men/Tshirts` lists points where
  category=Men, type=Tshirts.
- Each matching point appears as files named by its id: `<id>.json` (the full
  payload as JSON), `<id>.txt` (the embedded source text) when a text field is
  configured, and `<id>.<ext>` (raw blob bytes) when a blob field is configured.
  `<id>` is the Qdrant point id. The embedding vector itself is never shown.
- Semantic search is the `search` command: `search "red running shoes"` returns
  the top matching points as their content file paths with a similarity score.

Use ls/cd/cat/tree/find/grep as usual. Quote queries that contain spaces.\
"""
