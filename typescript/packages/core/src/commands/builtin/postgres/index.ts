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
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { POSTGRES_GREP } from './grep.ts'
import { POSTGRES_HEAD } from './head.ts'
import { POSTGRES_IO } from './io.ts'
import { POSTGRES_RG } from './rg.ts'
import { POSTGRES_TAIL } from './tail.ts'
import { POSTGRES_WC } from './wc.ts'

const POSTGRES_OVERRIDES = new Set(['grep', 'head', 'rg', 'tail', 'wc'])

export const POSTGRES_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<PostgresAccessor>(ResourceName.POSTGRES, POSTGRES_IO, {
    overrides: POSTGRES_OVERRIDES,
  }),
  ...POSTGRES_GREP,
  ...POSTGRES_HEAD,
  ...POSTGRES_RG,
  ...POSTGRES_TAIL,
  ...POSTGRES_WC,
]
