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

import { GDOCS_CMD_OPS } from '../../commands/builtin/gdocs/ops.ts'
import { ResourceName } from '../../types.ts'
import { makeGenericOps } from '../generic/factory.ts'
import type { RegisteredOp } from '../registry.ts'
import { readOp } from './read.ts'

// The only read is the rendered filetype op, so the factory's plain
// read is suppressed via overrides.
export const GDOCS_VFS_OPS: readonly RegisteredOp[] = [
  ...makeGenericOps(ResourceName.GDOCS, GDOCS_CMD_OPS, {
    overrides: new Set(['read']),
  }),
  readOp,
]
