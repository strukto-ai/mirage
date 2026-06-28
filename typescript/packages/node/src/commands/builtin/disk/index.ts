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

import {
  type RegisteredCommand,
  ResourceName,
  makeFiletypeCommands,
  makeGenericCommands,
} from '@struktoai/mirage-core'
import type { DiskAccessor } from '../../../accessor/disk.ts'
import { read as diskRead } from '../../../core/disk/read.ts'
import { stat as diskStat } from '../../../core/disk/stat.ts'
import { DISK_CMD_OPS } from './ops.ts'
import { DISK_SED } from './sed.ts'

export const DISK_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<DiskAccessor>({
    resource: ResourceName.DISK,
    readBytes: diskRead,
    statEntry: diskStat,
  }),
  ...makeGenericCommands<DiskAccessor>(ResourceName.DISK, DISK_CMD_OPS),
  ...DISK_SED,
]
