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

import type { S3Accessor } from '../../../accessor/s3.ts'
import { read as s3Read } from '../../../core/s3/read.ts'
import { stat as s3Stat } from '../../../core/s3/stat.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { S3_DU } from './du.ts'
import { S3_MKDIR } from './mkdir.ts'
import { S3_RM } from './rm.ts'
import { S3_STAT } from './stat.ts'
import { S3_TEE } from './tee.ts'
import { S3_TOUCH } from './touch.ts'
import { S3_CMD_OPS } from './ops.ts'

const S3_OVERRIDES = new Set(['stat', 'du', 'rm', 'mkdir', 'tee', 'touch'])

export const S3_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<S3Accessor>({
    resource: ResourceName.S3,
    readBytes: s3Read,
    statEntry: s3Stat,
  }),
  ...makeGenericCommands<S3Accessor>(ResourceName.S3, S3_CMD_OPS, {
    overrides: S3_OVERRIDES,
  }),
  ...S3_STAT,
  ...S3_DU,
  ...S3_RM,
  ...S3_MKDIR,
  ...S3_TEE,
  ...S3_TOUCH,
]
