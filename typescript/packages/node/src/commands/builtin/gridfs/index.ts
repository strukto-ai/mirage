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
  ResourceName,
  makeFiletypeCommands,
  makeGenericCommands,
  type RegisteredCommand,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { read as gridfsRead } from '../../../core/gridfs/read.ts'
import { stat as gridfsStat } from '../../../core/gridfs/stat.ts'
import { GRIDFS_DU } from './du.ts'
import { GRIDFS_IO } from './io.ts'
import { GRIDFS_MKDIR } from './mkdir.ts'
import { GRIDFS_RM } from './rm.ts'
import { GRIDFS_STAT } from './stat.ts'
import { GRIDFS_TEE } from './tee.ts'
import { GRIDFS_TOUCH } from './touch.ts'

// gridfs-specific behaviours kept as overrides: no real directories
// (mkdir -p, rm not-empty), write-tracking (touch/tee), du_multi
// aggregation, and the index-threaded, missing-operand stat.
const GRIDFS_OVERRIDES = new Set(['stat', 'du', 'rm', 'mkdir', 'tee', 'touch'])

export const GRIDFS_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<GridFSAccessor>({
    resource: ResourceName.GRIDFS,
    readBytes: gridfsRead,
    statEntry: gridfsStat,
  }),
  ...makeGenericCommands<GridFSAccessor>(ResourceName.GRIDFS, GRIDFS_IO, {
    overrides: GRIDFS_OVERRIDES,
  }),
  ...GRIDFS_STAT,
  ...GRIDFS_DU,
  ...GRIDFS_RM,
  ...GRIDFS_MKDIR,
  ...GRIDFS_TEE,
  ...GRIDFS_TOUCH,
]
