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

import type { PostgresAccessor } from '../../../accessor/postgres.ts'

import { VFSName } from '../../../types.ts'
import { command } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { scanIo } from '../generic_bind/index.ts'
import { runSearch } from '../generic_bind/search.ts'

import { IO } from './io.ts'

// The push-down is a literal-substring search that prints each matching
// row as a whole line; literalPushdownOperand defers a real regex, a
// multi-operand line and every shaping flag to the generic scan.
export const POSTGRES_GREP = command({
  name: 'grep',
  vfs: VFSName.POSTGRES,
  spec: specOf('grep'),
  fn: (accessor: PostgresAccessor, paths, texts, opts) =>
    runSearch<PostgresAccessor>(
      scanIo(IO, opts.ns, paths)[0],
      'grep',
      accessor,
      paths,
      texts,
      opts,
    ),
})
