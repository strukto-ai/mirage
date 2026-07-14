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

import { OperandKind } from '../../../commands/spec/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import { classifyWord } from './heuristic.ts'
import { classifyBarePath } from './path.ts'

// Classify a list of expanded words. The first element (command name)
// is never classified as a path. wordKinds (from CommandSpec, aligned
// with parts[1:]) decides per position: TEXT skips classification,
// PATH classifies even bare filenames, null falls back to the shape
// heuristics.
export function classifyParts(
  parts: string[],
  registry: MountRegistry,
  cwd: string,
  wordKinds: readonly (OperandKind | null)[] | null = null,
): (string | PathSpec)[] {
  if (parts.length === 0) return []
  const result: (string | PathSpec)[] = [parts[0] ?? '']
  for (let i = 1; i < parts.length; i++) {
    const w = parts[i]
    if (w === undefined) continue
    const kind = wordKinds !== null ? (wordKinds[i - 1] ?? null) : null
    if (kind === OperandKind.TEXT) {
      result.push(w)
    } else if (kind === OperandKind.PATH) {
      result.push(classifyBarePath(w, registry, cwd))
    } else {
      result.push(classifyWord(w, registry, cwd))
    }
  }
  return result
}
