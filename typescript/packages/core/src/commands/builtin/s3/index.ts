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
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { S3_MKDIR } from './mkdir.ts'
import { S3_RM } from './rm.ts'
import { S3_STAT } from './stat.ts'
import { S3_TEE } from './tee.ts'
import { S3_TOUCH } from './touch.ts'
import { S3_IO } from './io.ts'
import { withDefaultProvisions } from '../generic_bind/provision.ts'
import { resolveGlobOf } from '../generic_bind/adapter.ts'

const S3_OVERRIDES = new Set(['stat', 'rm', 'mkdir', 'tee', 'touch'])

export const S3_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<S3Accessor>(ResourceName.S3, S3_IO, {
    overrides: S3_OVERRIDES,
  }),
  ...withDefaultProvisions(
    [...S3_STAT, ...S3_RM, ...S3_MKDIR, ...S3_TEE, ...S3_TOUCH],
    S3_IO.stat,
    resolveGlobOf(S3_IO),
    S3_IO.readdir,
  ),
]
