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

import type { Accessor } from '../../../accessor/base.ts'
import { command, type RegisteredCommand } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FILETYPE_ENTRIES, type FiletypeReadBytesFn, type StatEntryFn } from './extensions.ts'
import { BUILDERS } from './handlers/index.ts'

export interface FiletypeCommandsOptions<A extends Accessor = Accessor> {
  resource: string
  readBytes: FiletypeReadBytesFn<A>
  statEntry: StatEntryFn<A>
}

export function makeFiletypeCommands<A extends Accessor = Accessor>(
  options: FiletypeCommandsOptions<A>,
): RegisteredCommand[] {
  const { resource, readBytes, statEntry } = options
  const commands: RegisteredCommand[] = []
  for (const entry of FILETYPE_ENTRIES) {
    for (const ext of entry.exts) {
      for (const [name, handler] of BUILDERS) {
        commands.push(
          ...command<A>({
            name,
            resource,
            spec: specOf(name),
            filetype: ext,
            fn: (accessor, paths, texts, opts) =>
              handler(readBytes, statEntry, entry, accessor, paths, texts, opts),
          }),
        )
      }
    }
  }
  return commands
}
