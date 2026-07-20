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

import type { DifyAccessor } from '../../../accessor/dify.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { DIFY_FIND } from './find.ts'
import { DIFY_IO } from './io.ts'
import { DIFY_SEARCH } from './search.ts'

const DIFY_OVERRIDES = new Set(['find', 'search'])

export const DIFY_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<DifyAccessor>(ResourceName.DIFY, DIFY_IO, {
    overrides: DIFY_OVERRIDES,
  }),
  ...DIFY_FIND,
  ...DIFY_SEARCH,
]
