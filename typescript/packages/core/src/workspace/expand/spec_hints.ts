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

import { execSpans } from '../../commands/builtin/find_parse.ts'
import { BUILTIN_SPECS } from '../../commands/spec/builtins.ts'
import { parseCommand } from '../../commands/spec/parser.ts'
import type { ValueType } from '../../commands/spec/types.ts'
import { type CommandSpec } from '../../commands/spec/types.ts'
import type { MountRegistry } from '../mount/registry.ts'

// Find the spec that classifies a mount command's words. The cwd
// mount's spec wins; the shared BUILTIN_SPECS table fills in when that
// mount does not register the command. Every session cwd sits under a
// mount (the workspace roots an implicit RAM mount), so mountFor never
// fails here; if it ever does, the registry is broken and the error
// should propagate (mirrors the Python docstring).
export function specForCommand(
  name: string,
  registry: MountRegistry,
  cwd: string,
): CommandSpec | null {
  const spec = registry.mountFor(cwd).specFor(name)
  if (spec !== null) return spec
  return BUILTIN_SPECS[name] ?? null
}

// Classify argv words into per-position operand kinds.
//
// Delegates to parseCommand so flag syntax (clusters, --flag=value,
// multiple flags, providedBy) classifies identically to dispatch. Kinds
// are positional, not value sets, so the same word can be TEXT in one slot
// and PATH in another (`grep '*.txt' *.txt`). Null marks a flag token,
// whose own classification the default handles.
//
// parseCommand classifies ignoreTokens as TEXT itself, so there is
// nothing to override here. A by-value override used to re-null them,
// which was both redundant and position-blind: it matched an option's
// value as readily as a grammar token, so `find /d -name '!'` lost the
// TEXT the parser had correctly given the pattern.
// find's `-exec` is the one grammar a spec cannot state (an option whose
// argument is a program, up to a terminator), so its words are overridden
// to TEXT here: the rest slot would otherwise read `echo`, `{}` and `;` as
// start points. The command name is what says the words are find's.
export function specWordKinds(
  spec: CommandSpec,
  argv: readonly string[],
  name = '',
): (ValueType | null)[] {
  const kinds = [...parseCommand(spec, [...argv], '/').wordKinds]
  if (name === 'find') {
    for (const [start, end] of execSpans(argv)) {
      for (let i = start; i <= end; i++) kinds[i] = 'str'
    }
  }
  return kinds
}

// Per-position base directories for a spec that declares one. tar's -C
// is a chdir for the operands typed after it, so those words are not
// relative to the session cwd at all. The parser already walks the line
// positionally, so it is what says where each word stood; this asks it,
// and only for the one command family that can answer (null everywhere
// else, so 92 of 93 specs pay nothing).
export function specWordBases(
  spec: CommandSpec,
  argv: readonly string[],
  cwd: string,
): (string | null)[] | null {
  if (spec.operandBase === null) return null
  return [...parseCommand(spec, [...argv], cwd).wordBases]
}
