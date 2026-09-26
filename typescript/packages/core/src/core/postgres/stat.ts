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

import type { PostgresAccessor } from '../../accessor/postgres.ts'
import { makeStat } from '../hierarchy/stat.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { entityGuard, readdir, schemaGuard } from './readdir.ts'
import { detectScope } from './scope.ts'

function schemaExtra(match: ScopeMatch): Record<string, string> {
  return { schema: match.slots.schema ?? '' }
}

function kindExtra(match: ScopeMatch): Record<string, string> {
  return { schema: match.slots.schema ?? '', kind: match.slots.kind ?? '' }
}

function entityExtra(match: ScopeMatch): Record<string, string> {
  return {
    schema: match.slots.schema ?? '',
    kind: match.slots.kind ?? '',
    name: match.slots.entity ?? '',
  }
}

export const stat = makeStat<PostgresAccessor>(detectScope, readdir, {
  guards: {
    schema: schemaGuard,
    kind: schemaGuard,
    entity: entityGuard,
    entity_schema: entityGuard,
    entity_semantic: entityGuard,
    entity_rows: entityGuard,
  },
  extras: {
    schema: schemaExtra,
    kind: kindExtra,
    entity: entityExtra,
    entity_schema: entityExtra,
    entity_semantic: entityExtra,
    entity_rows: entityExtra,
  },
})
