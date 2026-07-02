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

import type { MountRegistry } from '../../../../workspace/mount/registry.ts'
import type { PathSpec } from '../../../../types.ts'

export const TRANSFER_COMMANDS: ReadonlySet<string> = new Set(['cp', 'mv'])
export const COMPARE_COMMANDS: ReadonlySet<string> = new Set(['diff', 'cmp'])
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
])

export function isCrossMount(
  cmdName: string,
  scopes: PathSpec[],
  registry: MountRegistry,
): boolean {
  const allowed =
    TRANSFER_COMMANDS.has(cmdName) || COMPARE_COMMANDS.has(cmdName) || READ_COMMANDS.has(cmdName)
  if (!allowed || scopes.length < 2) return false
  const mounts = new Set<string>()
  for (const s of scopes) {
    const m = registry.mountFor(s.virtual)
    if (m !== null) mounts.add(m.prefix)
  }
  return mounts.size > 1
}
