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

import { IOResult } from '../../io/types.ts'
import { parseShell } from '../../rs/shell.ts'
import { encodeText } from '../bytes.ts'
import { ParsedProgram } from './program.ts'
import type { ShellNode, TSNodeLike } from '../types.ts'

/**
 * Parse a line as bash reads it. The parser folds each heredoc body into its
 * line as a `<` redirect from a double-quoted word, whose node carries the
 * heredoc, and drops the line continuations, so a word's text is what bash
 * reads; each node's `offsets` map the text back to the line as typed.
 * `aliases` are the names the shell expands as aliases: one is a command
 * where a command starts. `extglob` says whether extglob's pattern groups are
 * on. A line the parser refuses ends in an `ERROR` node, and its `error`
 * holds bash's refusal. Mirrors Python's parse.
 */
export function parse(
  command: string,
  aliases: ReadonlySet<string> = new Set(),
  extglob = true,
): ShellNode {
  return parseShell(command, aliases, extglob).rootNode
}

/** Parse a line into a program its holders release when done with it. */
export function parseProgram(
  command: string,
  aliases: ReadonlySet<string> = new Set(),
  extglob = true,
): ParsedProgram {
  return new ParsedProgram(command, parseShell(command, aliases, extglob).rootNode)
}

/**
 * What a line bash refuses yields: its diagnostic and status, null when bash
 * reads it. Status 2 is a syntax error, 1 an array bash cannot read, 127 a
 * substitution whose body bash cannot parse. Mirrors Python's syntax_refusal.
 */
export function syntaxRefusal(root: TSNodeLike): IOResult | null {
  const error = root.error
  if (error === undefined || error === null) return null
  return new IOResult({ exitCode: error.status, stderr: encodeText(error.message) })
}
