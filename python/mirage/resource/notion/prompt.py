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
      <data-source-title>__<data-source-id>/
        data_source.json
        <row-page-title>__<page-id>/
          page.json
  Hierarchical page tree plus shared databases. cat page.json shows
  metadata, the page body rendered as markdown, and raw blocks (nested
  blocks under "children"). A database is a container plus one or more
  data sources: database.json holds the container's identity and its
  data_sources stubs, while data_source.json holds the typed property
  schema (not the rows). ls a data source dir to list its row pages.

  Titles are sanitized; don't construct paths, ls the parent dir.
  ntn takes ids as positional operands, not flags: ntn pages get
  <page-id>, ntn datasources query <data-source-id>, ntn datasources
  resolve <database-id>."""

WRITE_PROMPT = """\
  Writes go through the ntn CLI when it is installed; run man ntn for \
the guide."""
