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

import { BUILTIN_SPECS } from '../../commands/spec/builtins.ts'
import { parseCommand } from '../../commands/spec/parser.ts'
import type { OperandKind } from '../../commands/spec/types.ts'
import { type CommandSpec } from '../../commands/spec/types.ts'
import type { MountRegistry } from '../mount/registry.ts'

// Find the spec that classifies a mount command's words. The cwd
// mount's spec wins; the shared BUILTIN_SPECS table fills in when that
// mount does not register the command. Every absolute path has a mount
// (the workspace roots an implicit RAM mount), so mountFor only
// returns null on a broken registry; the shared table still applies.
export function specForCommand(
  name: string,
  registry: MountRegistry,
  cwd: string,
): CommandSpec | null {
  const spec = registry.mountFor(cwd)?.specFor(name) ?? null
  if (spec !== null) return spec
  return BUILTIN_SPECS[name] ?? null
}

// Classify argv words into per-position operand kinds.
//
// Delegates to parseCommand so flag syntax (clusters, --flag=value,
// repeatable flags, providedBy) classifies identically to dispatch. Kinds
// are positional, not value sets, so the same word can be TEXT in one slot
// and PATH in another (`grep '*.txt' *.txt`). Null marks flag tokens and
// ignored words (default classification applies).
export function specWordKinds(spec: CommandSpec, argv: readonly string[]): (OperandKind | null)[] {
  const parsed = parseCommand(spec, [...argv], '/')
  const kinds: (OperandKind | null)[] = [...parsed.wordKinds]
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]
    if (word !== undefined && spec.ignoreTokens.has(word)) kinds[i] = null
  }
  return kinds
}
