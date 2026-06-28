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
{prefix}
  pages/
    <page-title>__<page-id>/
      page.json
      <child-page-title>__<child-id>/
        page.json
  databases/
    <database-title>__<database-id>/
      database.json
      <row-page-title>__<page-id>/
        page.json
  Hierarchical page tree plus shared databases. cat page.json shows
  metadata, the page body rendered as markdown, and raw blocks (nested
  blocks under "children"). cat database.json shows the database metadata
  and its typed property schema (not the rows); ls the database dir to
  list row pages.

  Titles are sanitized; don't construct paths, ls the parent dir.
  Use the <page-id>/<database-id> from a path segment as
  page_id/database_id/block_id in write commands."""

WRITE_PROMPT = """\
  Write commands:
    notion-page-create --json \
'{"parent":{"page_id":"..."},\
"properties":{"title":[{"text":{"content":"Title"}}]}}'
    notion-block-append --params '{"block_id":"..."}' --json \
'{"children":[...]}'
    notion-comment-add --json '{"parent":{"page_id":"..."},\
"rich_text":[{"text":{"content":"Comment"}}]}'"""
