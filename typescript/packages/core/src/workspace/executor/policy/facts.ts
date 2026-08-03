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

import { SPECS } from '../../../commands/spec/index.ts'
import type { TSNodeLike } from '../../expand/variable.ts'
import type { ParsedCommand } from './types.ts'

const WORD_TYPES: ReadonlySet<string> = new Set([
  'command_name',
  'word',
  'string',
  'raw_string',
  'number',
  'concatenation',
])

/**
 * Distill a parsed line into one ParsedCommand per command. `clis`
 * holds the installed CLI head words; a command whose name is one of
 * them carries it as `cli`.
 */
export function parsedCommands(
  root: TSNodeLike,
  clis: ReadonlySet<string> = new Set(),
): ParsedCommand[] {
  const commands: ParsedCommand[] = []
  const stack: TSNodeLike[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (node.type === 'command') {
      const words = node.children.filter((c) => WORD_TYPES.has(c.type)).map((c) => c.text)
      const [command] = words
      if (command !== undefined) {
        commands.push({
          command,
          words,
          // hasOwn, not `in`: a command named after an Object.prototype
          // key (`toString`) must not report as a builtin.
          builtin: Object.hasOwn(SPECS, command),
          paths: words.slice(1).filter((w) => w.startsWith('/')),
          cli: clis.has(command) ? command : null,
        })
      }
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i]
      if (child !== undefined) stack.push(child)
    }
  }
  return commands
}
