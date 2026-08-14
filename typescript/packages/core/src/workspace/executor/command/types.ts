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

import type { ByteSource, IOResult } from '../../../io/types.ts'
import type { ExecutionNode } from '../../types.ts'
import type { FlagValue } from '../../../commands/spec/types.ts'
import type { PathSpec } from '../../../types.ts'

export type Result = [ByteSource | null, IOResult, ExecutionNode]
export type Flags = Record<string, FlagValue>

/**
 * One parsed command line, named field for field after Python's
 * `ParsedCommand` NamedTuple (executor/command/types.py). It replaces
 * a bare 15-slot positional tuple whose four identical `string[]`
 * slots could be swapped without a compile error, silently changing
 * which usage error is reported.
 */
export interface ParsedCommand {
  paths: PathSpec[]
  texts: string[]
  flagKwargs: Record<string, FlagValue>
  warnings: string[]
  invalidOptions: string[]
  ambiguousOptions: [string, readonly string[]][]
  optionErrorKinds: string[]
  needsValueOptions: string[]
  invalidValueOptions: [string, string, readonly string[]][]
  invalidIntOptions: [string, string][]
  invalidFloatOptions: [string, string][]
  missingRequiredOptions: string[]
  oldOptionNeedsValue: string | null
  // Only a CLI reads these two: the display names of required operand
  // slots the line left empty, and the dests it actually typed in scan
  // order. Both feed a usage line rendered in another program's
  // dialect, which is why they carry names and order at all.
  missingRequiredOperands: readonly string[]
  typedDests: readonly string[]
}
