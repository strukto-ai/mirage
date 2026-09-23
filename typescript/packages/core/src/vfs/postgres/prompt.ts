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

export const POSTGRES_PROMPT = `{prefix}
  database.json                  cross-schema graph + sizes
  <schema>/                      Postgres schema (namespace)
    tables/<table>/
      schema.json                column types, PK/FK, indexes
      rows.jsonl                 data (size-guarded)
    views/<view>/
      schema.json
      rows.jsonl
  Read database.json first to plan joins. Reading rows.jsonl is refused
  for tables above the configured row/byte threshold; use head, tail, wc,
  or grep, all of which push predicates down to SQL.`
