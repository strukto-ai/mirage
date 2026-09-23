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
This mount is a LanceDB table exposed as a filesystem.

Layout:
- Directories are the configured group-by columns. Descending narrows a filter,
  e.g. `ls Men/Tshirts/Blue` lists rows where gender=Men, articleType=Tshirts,
  baseColour=Blue.
- Each matching row appears as two files: `<id>.md` (a readable card with all
  attributes) and `<id>.<ext>` (the raw blob/image bytes), when a blob column is
  configured.
- Semantic search is a virtual folder named `_search`. Read a query as a path
  segment: `ls "_search/red running shoes"` returns the top matches as row
  files; `cat "_search/red running shoes/<id>.md"` shows the card with a score.

Use ls/cd/cat/tree/find/grep as usual. Quote queries that contain spaces.\
"""
