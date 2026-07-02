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

import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { interpretEscapes } from '../utils/escapes.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function expandRanges(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (i + 2 < s.length && s[i + 1] === '-') {
      const start = s.charCodeAt(i)
      const end = s.charCodeAt(i + 2)
      for (let c = start; c <= end; c++) out += String.fromCharCode(c)
      i += 3
    } else {
      out += s[i] ?? ''
      i += 1
    }
  }
  return out
}

interface TrOptions {
  set1: string
  set2: string
  del: boolean
  squeeze: boolean
  table: Map<string, string> | null
}

async function* trStream(
  source: AsyncIterable<Uint8Array>,
  opts: TrOptions,
): AsyncIterable<Uint8Array> {
  const squeezeSet: Set<string> =
    opts.squeeze && opts.set2 !== ''
      ? new Set(opts.set2)
      : opts.squeeze
        ? new Set(opts.set1)
        : new Set()
  let prevChar = ''
  for await (const chunk of source) {
    const text = DEC.decode(chunk)
    let result: string
    if (opts.del) {
      const set1Set = new Set(opts.set1)
      result = Array.from(text)
        .filter((c) => !set1Set.has(c))
        .join('')
    } else if (opts.table !== null) {
      result = Array.from(text)
        .map((c) => opts.table?.get(c) ?? c)
        .join('')
    } else {
      result = text
    }
    if (squeezeSet.size > 0) {
      const squeezed: string[] = []
      for (const c of result) {
        if (squeezeSet.has(c) && c === prevChar) continue
        squeezed.push(c)
        prevChar = c
      }
      result = squeezed.join('')
    } else if (result.length > 0) {
      prevChar = result[result.length - 1] ?? ''
    }
    yield ENC.encode(result)
  }
}

function buildOptions(
  texts: readonly string[],
  flags: Record<string, string | boolean | string[]>,
): TrOptions {
  if (texts.length === 0) throw new Error('tr: usage: tr [-d] [-s] [-c] set1 [set2] [path]')
  let set1 = expandRanges(interpretEscapes(texts[0] ?? ''))
  if (flags.c === true) {
    let allChars = ''
    for (let i = 0; i < 128; i++) allChars += String.fromCharCode(i)
    const s1 = new Set(set1)
    set1 = Array.from(allChars)
      .filter((c) => !s1.has(c))
      .join('')
  }
  let set2 = texts.length >= 2 ? expandRanges(interpretEscapes(texts[1] ?? '')) : ''
  if (set2 !== '' && set2.length < set1.length) {
    const last = set2[set2.length - 1] ?? ''
    set2 = set2 + last.repeat(set1.length - set2.length)
  }
  const del = flags.d === true
  const squeeze = flags.s === true
  let table: Map<string, string> | null = null
  if (!del && set2 !== '') {
    table = new Map<string, string>()
    for (let i = 0; i < set1.length; i++) {
      const from = set1[i]
      const to = set2[i]
      if (from !== undefined && to !== undefined) table.set(from, to)
    }
  } else if (!del && set2 === '' && !squeeze) {
    throw new Error('tr: usage: tr set1 set2')
  }
  return { set1, set2, del, squeeze, table }
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function trGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  let trOpts: TrOptions
  try {
    trOpts = buildOptions(texts, opts.flags)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
  const cache: string[] = []
  let source: AsyncIterable<Uint8Array>
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    source = stream(first)
    cache.push(first.virtual)
  } else {
    source = resolveSource(opts.stdin)
  }
  return [trStream(source, trOpts), new IOResult({ cache })]
}
