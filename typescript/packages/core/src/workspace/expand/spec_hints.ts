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

import { parseCommand } from '../../commands/spec/parser.ts'
import { type CommandSpec, OperandKind } from '../../commands/spec/types.ts'

// Classify argv into TEXT and PATH sets using a CommandSpec.
//
// Delegates to parseCommand so flag syntax (clusters, --flag=value,
// repeatable flags, providedBy) classifies identically to dispatch, then
// maps the raw (unresolved) operand words to their kinds. Flag values with
// TEXT kind are also added to the text set.
export function specWordKinds(
  spec: CommandSpec,
  argv: readonly string[],
): [Set<string>, Set<string>] {
  const parsed = parseCommand(spec, [...argv], '/')
  const textSet = new Set<string>()
  const pathSet = new Set<string>()
  for (const [word, kind] of parsed.rawOperands) {
    if (kind === OperandKind.TEXT) textSet.add(word)
    else if (kind === OperandKind.PATH) pathSet.add(word)
  }
  for (const value of parsed.textFlagValues) textSet.add(value)
  for (const tok of spec.ignoreTokens) {
    textSet.delete(tok)
    pathSet.delete(tok)
  }
  return [textSet, pathSet]
}
