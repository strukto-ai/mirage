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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { cacheAwareStreamEager } from '../../../cache/read_through.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import {
  countNewlines,
  normalizeCounts,
  numberFlagError,
  parseCounts,
  tailBytes,
  type TailCounts,
} from '../tail_helper.ts'
import { fsErrorLine, isFsError } from '../../../utils/errors.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

// Whether this operand's whole content is what tail emits, which is what
// makes it worth handing to the file cache. Counting from the start is
// never treated as a full read, matching what `-n +N` has always done.
function readsEverything(rawCounts: TailCounts, raw: Uint8Array): boolean {
  const counts = normalizeCounts(rawCounts)
  if (counts.fromByte !== null || counts.fromLine !== null) return false
  if (counts.byteCount !== null) return counts.byteCount >= raw.byteLength
  return (counts.lines ?? 10) >= countNewlines(raw)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export async function tailGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('tail'))
  stream = cacheAwareStreamEager(stream)
  const nRaw = fl.asStr('n') ?? null
  const cRaw = fl.asStr('c') ?? null
  const numErr = numberFlagError('tail', nRaw, cRaw)
  if (numErr !== null) return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(numErr) })]
  const qFlag = fl.asBool('q')
  const vFlag = fl.asBool('v')
  const counts = parseCounts(nRaw, cRaw)

  if (paths.length > 0) {
    const chunks: Uint8Array[] = []
    const cache: string[] = []
    const showHeaders = (vFlag || paths.length > 1) && !qFlag
    let err = ''
    let printed = 0
    for (const p of paths) {
      let raw: Uint8Array
      try {
        raw = await materialize(stream(p))
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('tail', p, e)
        continue
      }
      if (showHeaders) {
        // Separator keyed on printed blocks, not operand index: a good file
        // after a failed operand starts without a leading blank line (GNU).
        const header = printed > 0 ? `\n==> ${p.rawPath} <==\n` : `==> ${p.rawPath} <==\n`
        chunks.push(ENC.encode(header))
      }
      printed += 1
      chunks.push(tailBytes(raw, counts))
      if (readsEverything(counts, raw)) cache.push(p.virtual)
    }
    const io = new IOResult({
      cache,
      exitCode: err === '' ? 0 : 1,
      stderr: err === '' ? null : ENC.encode(err),
    })
    if (printed === 0 && err !== '') return [null, io]
    const out: ByteSource = concat(chunks)
    return [out, io]
  }
  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tail: missing operand\n') })]
  }
  return [tailBytes(raw, counts), new IOResult()]
}
