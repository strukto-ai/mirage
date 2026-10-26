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

import { parseShell } from '../../rs/shell.ts'
import { ParsedProgram } from './program.ts'
import { heredocOperators } from './heredoc/index.ts'
import { discoverHeredocs, readPlanned } from './heredoc/reader.ts'
import { heredocPlan } from './syntax.ts'
import { dropSourceChars, lowerHeredocs } from './heredoc/lower.ts'
import { HeredocNode } from './heredoc/node.ts'
import { continuationIndices, joinContinuations, sourceOffsets } from './source.ts'
import type { ShellNode } from '../types.ts'

/**
 * Parse shell structure after the source reader gathers heredocs. Bodies
 * become inline expansion words with reader-owned input metadata; nodes
 * retain their original source for nested evaluation. A line the reader
 * refuses takes its heredocs from the parser's tree. Line continuations are
 * joined first, so a word's text is what bash reads. `aliases` are the names
 * the shell expands as aliases: one is a command where a command starts. A
 * line the parser refuses ends in an `ERROR` node. Mirrors Python's parse.
 */
export function parse(command: string, aliases: ReadonlySet<string> = new Set()): ShellNode {
  const plan = command.includes('<<') ? heredocPlan(command) : null
  const documents = !command.includes('<<')
    ? []
    : plan !== null
      ? readPlanned(command, plan)
      : discoverHeredocs(command, heredocOperators(parseShell(command).rootNode))
  if (documents.length === 0) return parseShell(joinContinuations(command), aliases).rootNode
  const lowered = lowerHeredocs(command, documents, plan?.closes)
  const source = dropSourceChars(lowered, continuationIndices(lowered.source))
  return new HeredocNode(parseShell(source.source, aliases).rootNode, source)
}

/** Parse a line into a program its holders release when done with it. */
export function parseProgram(
  command: string,
  aliases: ReadonlySet<string> = new Set(),
): ParsedProgram {
  const root = parse(command, aliases)
  return new ParsedProgram(command, root, sourceOffsets(command, root))
}
