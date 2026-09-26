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

import type { SearchQuery } from '../../../vfs/types.ts'
import { IOResult } from '../../../io/types.ts'
import { isEfbig } from '../../../utils/errors.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'

import { grepGeneric } from '../generic/grep.ts'
import { foldsCase, parseFlags as parseRgFlags, rgGeneric } from '../generic/rg.ts'
import {
  grepSearchMeta,
  textSearchResults,
  literalPushdownOperand,
  pushdownOperand,
} from '../grep_pushdown.ts'
import { PATTERN_KEYS, patternArg } from '../grep_pattern.ts'
import { formatRecords } from '../utils/output.ts'
import { resolveGlobOf, type CommandIO } from './adapter.ts'

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

// How a native search matches the pushed-down pattern.
export function searchOptions(
  name: 'grep' | 'rg',
  fl: FlagView,
  pattern: string,
): Record<string, boolean> {
  if (name === 'rg') {
    const f = parseRgFlags(fl)
    return {
      ignore_case: foldsCase(pattern, f.fixedString, f),
      fixed_string: f.fixedString,
      whole_word: f.wholeWord,
      basic: false,
    }
  }
  return {
    ignore_case: fl.asBool('i'),
    fixed_string: fl.asBool('F'),
    whole_word: fl.asBool('w'),
    basic: !fl.asBool('E'),
  }
}

/** Execute an adapter's qualified search; null requests the generic scan. */
export async function runSearch<A extends Accessor>(
  io: CommandIO<A>,
  name: 'grep' | 'rg',
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const capability = io.search
  const meta = grepSearchMeta(capability)
  const fl = new FlagView(opts.flags, specOf(name))
  const pattern = patternArg(texts, opts.flags, PATTERN_KEYS[name])
  const gate = meta?.mode === 'literal' ? literalPushdownOperand : pushdownOperand
  const operand = gate(paths, opts.flags, pattern)
  if (
    capability !== undefined &&
    meta !== null &&
    pattern !== null &&
    operand !== null &&
    !hiddenPathsIntersect(operand.virtual) &&
    !pathRulesActive()
  ) {
    const query: SearchQuery = {
      query: pattern,
      options: { grep: searchOptions(name, fl, pattern) },
    }
    let lines: string[] | null
    try {
      lines = await capability.search(accessor, operand, query, opts.index ?? undefined)
    } catch (err) {
      // A push-down whose answer is past the mount's read cap cannot print
      // it; the scan reads each operand, and reports the same refusal against
      // the operand as typed.
      if (!isEfbig(err)) throw err
      lines = null
    }
    if (lines !== null) {
      if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      if (name !== 'grep' || textSearchResults(lines)) return [formatRecords(lines), new IOResult()]
    }
  }
  const resolved =
    paths.length > 0 ? await resolveGlobOf(io)(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => io.stat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    io.readdir(accessor, p, opts.index ?? undefined)
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    meta === null || meta.stream
      ? nativeOrBytes(io, accessor, p, opts.index ?? undefined)
      : bytesStream(io, accessor, p, opts.index ?? undefined)
  const generic = GENERICS[name]
  if (generic === undefined) throw new Error(`runSearch: no generic for ${name}`)
  return generic(resolved, texts, opts, stat, readdir, stream)
}
