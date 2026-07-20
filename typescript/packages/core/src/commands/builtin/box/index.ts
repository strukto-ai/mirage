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

import type { BoxAccessor } from '../../../accessor/box.ts'
import { read as boxRead } from '../../../core/box/read.ts'
import { stat as boxStat } from '../../../core/box/stat.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { BOX_GREP } from './grep.ts'
import { BOX_IO } from './io.ts'
import { BOX_RG } from './rg.ts'

const BOX_OVERRIDES = new Set(['grep', 'rg'])

export const BOX_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<BoxAccessor>({
    resource: ResourceName.BOX,
    readBytes: boxRead,
    statEntry: boxStat,
  }),
  ...makeGenericCommands<BoxAccessor>(ResourceName.BOX, BOX_IO, {
    overrides: BOX_OVERRIDES,
  }),
  ...BOX_GREP,
  ...BOX_RG,
]
