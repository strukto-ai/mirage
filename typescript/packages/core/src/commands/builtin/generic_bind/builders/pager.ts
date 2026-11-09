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

import type { CommandFn } from '../../../config.ts'
import { pagerGeneric } from '../../generic/pager.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, dirAwareStream, resolveOrEmpty } from '../files.ts'

function pager(command: string): CommandFn {
  return async (_accessor, paths, _texts, ctx) => {
    const operands = paths.filter((p) => !p.rawPath.startsWith('+'))
    const files = commandFiles(ctx, operands)
    const resolved = await resolveOrEmpty(files, operands)
    return pagerGeneric(resolved, ctx, dirAwareStream(files, ctx), command)
  }
}

export const BUILDERS: readonly GenericCommand[] = ['less', 'more', 'zless', 'zmore'].map(
  (name) => ({ name, read: true, passThrough: true, fn: pager(name) }),
)
