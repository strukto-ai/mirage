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

import type { RAMAccessor } from '../../../accessor/ram.ts'
import { read as ramRead } from '../../../core/ram/read.ts'
import { stat as ramStat } from '../../../core/ram/stat.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { RAM_CMD_OPS } from './ops.ts'

export const RAM_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<RAMAccessor>({
    resource: ResourceName.RAM,
    readBytes: ramRead,
    statEntry: ramStat,
  }),
  ...makeGenericCommands<RAMAccessor>(ResourceName.RAM, RAM_CMD_OPS),
]
