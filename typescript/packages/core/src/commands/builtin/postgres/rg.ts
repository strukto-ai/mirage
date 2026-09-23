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

import { detectScope } from '../../../core/postgres/scope.ts'
import { SEARCHERS } from '../../../core/postgres/search.ts'
import { VFSName } from '../../../types.ts'
import { command } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { makeSearch } from '../generic_bind/search.ts'
import { literalPushdownOperand } from '../grep_pushdown.ts'
import { POSTGRES_IO } from './io.ts'

export const POSTGRES_RG = command({
  name: 'rg',
  vfs: VFSName.POSTGRES,
  spec: specOf('rg'),
  fn: makeSearch('rg', detectScope, SEARCHERS, POSTGRES_IO, {
    qualify: literalPushdownOperand,
    guard: true,
  }),
})
