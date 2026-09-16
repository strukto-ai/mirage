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

import type { Accessor } from '../../../accessor/base.ts'
import { hiddenPathsIntersect, pathRulesActive } from '../../../context/session_context.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { ROOT, type DetectFn } from '../../../core/hierarchy/scope.ts'
import type { Searcher, SearchQuery } from '../../../core/hierarchy/search.ts'
import { IOResult } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView, type FlagValue } from '../../spec/types.ts'
import { grepGeneric } from '../generic/grep.ts'
import { rgGeneric } from '../generic/rg.ts'
import { textSearchResults } from '../grep_pushdown.ts'
import { patternArg } from '../grep_pattern.ts'
import { formatRecords } from '../utils/output.ts'
import { resolveGlobOf, type CommandIO } from './adapter.ts'

export type QualifyFn = (
  paths: PathSpec[],
  bag: Record<string, FlagValue>,
  pattern: string | null,
) => PathSpec | null

type GenericScan = (
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: (p: PathSpec) => Promise<FileStat>,
  readdir: (p: PathSpec) => Promise<string[]>,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
) => Promise<CommandFnResult>

const GENERICS: Record<string, GenericScan> = {
  grep: (paths, texts, opts, stat, readdir, stream) =>
    grepGeneric('grep', paths, texts, opts, stat, readdir, stream),
  rg: rgGeneric,
}

async function* bytesStream<A extends Accessor>(
  io: CommandIO<A>,
  accessor: A,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await io.readBytes(accessor, p, index)
}

// A native stream may serve only some kinds (mongodb streams documents.jsonl
// and refuses schema.json before yielding anything), so a first-pull failure
// falls back to the whole read; an error after data has flowed is real and
// propagates. Mirrors the python generic, which streams only where the
// backend can serve and reads bytes everywhere else.
async function* nativeOrBytes<A extends Accessor>(
  io: CommandIO<A>,
  accessor: A,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const it = io.readStream(accessor, p, index)[Symbol.asyncIterator]()
  let first: IteratorResult<Uint8Array>
  try {
    first = await it.next()
  } catch {
    yield await io.readBytes(accessor, p, index)
    return
  }
  while (!first.done) {
    yield first.value
    first = await it.next()
  }
}

/**
 * Build a grep/rg handler: push a qualified search down, scan the rest.
 *
 * The handler is the shared shape every hierarchy backend's search wrapper
 * had by hand: qualify the line, classify the operand, hand a matched kind
 * to its searcher, and print the lines it answers (an empty answer is
 * grep's exit 1). Anything the push-down cannot answer, an unqualified
 * line, an unmatched kind, or a missing pattern, takes the generic scan
 * wired from the same `io` the backend's other commands use. `qualify` is
 * which lines may push down (`literalPushdownOperand` for a substring
 * backend, `pushdownOperand` for a regex one); `guard` stats the operand
 * before a non-root search runs; `stream` wires the backend's native
 * readStream into the generic scan instead of the whole-read path.
 */
export function makeSearch<A extends Accessor>(
  name: 'grep' | 'rg',
  detect: DetectFn,
  searchers: Readonly<Record<string, Searcher<A>>>,
  io: CommandIO<A>,
  options: { qualify: QualifyFn; guard?: boolean; stream?: boolean },
): (
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
) => Promise<CommandFnResult> {
  const spec = specOf(name)
  const resolveGlob = resolveGlobOf(io)

  return async function searchCmd(
    accessor: A,
    paths: PathSpec[],
    texts: string[],
    opts: CommandOpts,
  ): Promise<CommandFnResult> {
    const fl = new FlagView(opts.flags, spec)
    const pattern = patternArg(texts, opts.flags)
    const operand = options.qualify(paths, opts.flags, pattern)
    // A native search answers from the raw backend, so it would print
    // lines out of files the session cannot see, or ones a path rule
    // refuses; the generic scan classifies through the guarded
    // readdir/stat instead. Per operand, like find's fork.
    const pushdownOpen =
      operand === null || (!hiddenPathsIntersect(operand.virtual) && !pathRulesActive())
    if (pattern !== null && operand !== null && pushdownOpen) {
      const match = detect(operand)
      const searcher = searchers[match.kind]
      if (searcher !== undefined) {
        if (options.guard === true && match.kind !== ROOT) {
          await io.stat(accessor, operand, opts.index ?? undefined)
        }
        const query: SearchQuery = {
          pattern,
          ignoreCase: fl.asBool('i'),
          fixedString: fl.asBool('F'),
          wholeWord: fl.asBool('w'),
        }
        const lines = await searcher(accessor, match, query)
        if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
        if (name !== 'grep' || textSearchResults(lines))
          return [formatRecords(lines), new IOResult()]
      }
    }

    const resolved =
      paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
    const stat = (p: PathSpec): Promise<FileStat> => io.stat(accessor, p, opts.index ?? undefined)
    const readdir = (p: PathSpec): Promise<string[]> =>
      io.readdir(accessor, p, opts.index ?? undefined)
    const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
      options.stream === true
        ? nativeOrBytes(io, accessor, p, opts.index ?? undefined)
        : bytesStream(io, accessor, p, opts.index ?? undefined)
    const generic = GENERICS[name]
    if (generic === undefined) throw new Error(`makeSearch: no generic for ${name}`)
    return generic(resolved, texts, opts, stat, readdir, stream)
  }
}
