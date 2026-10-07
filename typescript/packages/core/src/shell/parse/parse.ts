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

import { repairAssignments } from './assignment.ts'

import { ParseTrees, type NativeParser } from './engine.ts'
import { ParsedProgram, ProgramNode } from './program.ts'
import { Language, Parser } from 'web-tree-sitter'
import type { ShellParserConfig } from './config.ts'
import { heredocOperators } from './heredoc/index.ts'
import { lowerTiming, wrapTiming, type TimingMark } from './timing.ts'
import { discoverHeredocs } from './heredoc/reader.ts'
import { dropSourceChars, lowerHeredocs, rebaseSource } from './heredoc/lower.ts'
import { HeredocNode } from './heredoc/node.ts'
import { continuationIndices, joinContinuations, sourceOffsets } from './source.ts'
import {
  isArithmetic,
  operatorSource,
  parseProtected,
  failedArithOpeners,
  repairForHeaders,
  repairOrphanedDollars,
  repairRedirectDashes,
  statementBoundaries,
} from './recovery.ts'
import type { ShellNode, TSNodeLike } from '../types.ts'

export interface ShellParser {
  parseProgram(command: string): ParsedProgram
  dispose(): void
  parse(command: string): ShellNode
  /** Where each char of the source `parse` read sits in `command`. */
  sourceOffsets(command: string, root: TSNodeLike): readonly number[]
}

// `Parser.init` boots one wasm module for the whole process, so two callers
// that start at the same time used to race it: the second read the language
// out of a half-built module and threw "Incompatible language version 0".
// Every caller now awaits the same boot. A failed boot is not kept, or one bad
// start would poison every later parser.
let engineBoot: Promise<void> | null = null

export async function createShellParser(config: ShellParserConfig): Promise<ShellParser> {
  engineBoot ??= Parser.init({ wasmBinary: toArrayBuffer(config.engineWasm) }).catch(
    (err: unknown) => {
      engineBoot = null
      throw err
    },
  )
  await engineBoot
  const language = await Language.load(toUint8(config.grammarWasm))
  const parser = new Parser()
  parser.setLanguage(language)
  let disposed = false
  return {
    /**
     * Parse shell structure after the source reader gathers heredocs.
     * Bodies become inline expansion words with reader-owned input metadata;
     * nodes retain their original source for nested evaluation.
     *
     * A leading `((` is lexed as the arithmetic opener and the lexer
     * cannot back out, so a subshell that immediately opens another
     * subshell (`((echo a); echo b)`) fails to parse. Bash resolves the
     * same ambiguity by trying the arithmetic command and reparsing as
     * nested subshells when that fails; this does the same, splitting
     * only openers that already sit inside an error and keeping the
     * retry only if it parses cleanly. Commands that parse today are
     * untouched, so no working command's offsets move.
     *
     * A later unbraced `$var` followed by a name-terminating character
     * is mis-lexed by the grammar, leaving a literal `$` token behind
     * (see orphanedDollarOffsets); those expansions are rebraced and
     * the line reparsed, so the returned tree can spell `$id` as
     * `${id}`.
     */
    parse(this: ShellParser, command: string): ShellNode {
      return this.parseProgram(command).root
    },
    parseProgram(command: string): ParsedProgram {
      if (disposed) throw new Error('shell parser is disposed')
      const trees = new ParseTrees(parser)
      try {
        const root = parseRoot(trees, command)
        const offsets = sourceOffsets(trees, command, root)
        const tree = trees.take(root)
        return new ParsedProgram(command, root, offsets, () => {
          tree.delete()
        })
      } finally {
        trees.release()
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      parser.delete()
    },
    sourceOffsets(command: string, root: TSNodeLike): readonly number[] {
      if (root instanceof ProgramNode && root.program.original === command)
        return root.program.offsets
      const trees = new ParseTrees(parser)
      try {
        return sourceOffsets(trees, command, root)
      } finally {
        trees.release()
      }
    },
  }
}

function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function toUint8(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

function parseRoot(parser: NativeParser, command: string): ShellNode {
  let hinted = command.includes('<<') ? (parser.parse(command)?.rootNode ?? null) : null
  if (hinted !== null) {
    // The operators are read off a tree that lexes `0<<EOF` as one.
    const lexed = operatorSource(parser, command, hinted)
    if (lexed !== command) hinted = parser.parse(lexed)?.rootNode ?? hinted
  }
  const documents = hinted === null ? [] : discoverHeredocs(command, heredocOperators(hinted))
  const lowered = documents.length > 0 ? lowerHeredocs(command, documents) : null
  let heredocs =
    lowered === null ? null : dropSourceChars(lowered, continuationIndices(parser, lowered.source))
  let input = heredocs?.source ?? joinContinuations(parser, command)
  let timingMarks: readonly TimingMark[] = []
  if (input.includes('time') || input.includes('!')) {
    heredocs ??= dropSourceChars(
      {
        original: command,
        source: command,
        offsets: Array.from({ length: command.length + 1 }, (_, i) => i),
        documents: [],
      },
      continuationIndices(parser, command),
    )
    ;[heredocs, timingMarks] = lowerTiming(parser, heredocs)
    input = heredocs.source
  }
  const source = statementBoundaries(parser, input)
  let root = parseProtected(parser, source)
  let text = source
  if (root.hasError) {
    // Sitting inside an ERROR is not evidence that an opener is
    // broken: tree-sitter's error region swallows neighbouring tokens,
    // so a valid `((i++))` next to a bad opener reports as errored
    // too. Splitting it would silently turn arithmetic into a subshell
    // running `i++`, which is a wrong parse rather than a rejected
    // one. Each opener is judged on its own span instead.
    const offsets = [...new Set(failedArithOpeners(root))].filter(
      (o) => !isArithmetic(parser, source, o),
    )
    if (offsets.length > 0) {
      let split = source
      for (const offset of offsets.sort((a, b) => b - a)) {
        split = `${split.slice(0, offset + 1)} ${split.slice(offset + 1)}`
      }
      const retried = parseProtected(parser, split)
      if (!retried.hasError) {
        root = retried
        text = split
      }
    }
  }
  ;[root, text] = repairRedirectDashes(parser, root, text)
  if (text.includes('for') || text.includes('select')) {
    ;[root, text] = repairForHeaders(parser, root, text)
  }
  if (text.includes('$')) {
    root = repairOrphanedDollars(parser, root, text)
  }
  root = repairAssignments(parser, root, text.slice(0, root.startIndex) + root.text)
  if (heredocs === null) return root
  const mappedSource = rebaseSource(heredocs, heredocs.source.slice(0, root.startIndex) + root.text)
  const mapped = new HeredocNode(root, mappedSource)
  return timingMarks.length === 0 ? mapped : wrapTiming(mapped, mappedSource, timingMarks)
}
