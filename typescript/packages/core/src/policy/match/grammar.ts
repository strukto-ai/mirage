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

import type { ParsedArgs } from '../../commands/spec/parser.ts'
import type { FlagValue } from '../../commands/spec/types.ts'
import { PathSpec } from '../../types.ts'
import type { CommandRead, FlagFact } from '../types.ts'

function values(value: FlagValue | undefined): string[] {
  if (Array.isArray(value)) return value.flatMap((part) => values(part))
  if (value instanceof PathSpec) return [value.virtual]
  if (typeof value === 'string') return [value]
  return []
}

/**
 * Each named option with the values it holds. `flags` are option values by
 * canonical spelling, as a parse or a walk left them; `dests` the options
 * the words carry, in order.
 */
export function flagFacts(
  flags: Readonly<Record<string, FlagValue>>,
  dests: Iterable<string>,
): FlagFact[] {
  return [...dests].map((dest) => ({ name: dest, values: values(flags[dest]) }))
}

/**
 * A leaf's parse as a read: the options the words carry, typed or filled
 * from the environment, never a declared default, and the operands as
 * written. null when the grammar refuses the words' options; a missing
 * operand or required option does not count.
 */
export function leafRead(path: readonly string[], parsed: ParsedArgs): CommandRead | null {
  if (parsed.optionErrorKinds.length > 0 || parsed.oldOptionNeedsValue !== null) return null
  const dests = [...parsed.typedDests, ...parsed.envDests]
  return {
    path: [...path],
    flags: flagFacts(parsed.flags, dests),
    operands: parsed.rawOperands.map(([word]) => word),
  }
}
