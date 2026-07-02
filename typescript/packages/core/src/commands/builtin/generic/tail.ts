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

import { cacheAwareStreamEager } from '../../../cache/read_through.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { countNewlines, numberFlagError, parseN, tailBytes } from '../tail_helper.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

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
  stream = cacheAwareStreamEager(stream)
  const nRaw = typeof opts.flags.n === 'string' ? opts.flags.n : null
  const cRaw = typeof opts.flags.c === 'string' ? opts.flags.c : null
  const numErr = numberFlagError('tail', nRaw, cRaw)
  if (numErr !== null) return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(numErr) })]
  const qFlag = opts.flags.q === true
  const vFlag = opts.flags.v === true
  const [lines, plusMode] = parseN(nRaw)
  const bytesMode = cRaw !== null ? Number.parseInt(cRaw, 10) : null

  if (paths.length > 0) {
    const chunks: Uint8Array[] = []
    const cache: string[] = []
    const showHeaders = (vFlag || paths.length > 1) && !qFlag
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]
      if (p === undefined) continue
      const raw = await materialize(stream(p))
      if (showHeaders) {
        const header = i > 0 ? `\n==> ${p.display} <==\n` : `==> ${p.display} <==\n`
        chunks.push(ENC.encode(header))
      }
      if (bytesMode !== null) {
        chunks.push(bytesMode === 0 ? new Uint8Array(0) : raw.slice(-bytesMode))
        if (bytesMode >= raw.byteLength) cache.push(p.virtual)
      } else {
        chunks.push(tailBytes(raw, lines, null, plusMode))
        if (!plusMode && lines >= countNewlines(raw)) cache.push(p.virtual)
      }
    }
    const out: ByteSource = concat(chunks)
    return [out, new IOResult({ cache })]
  }
  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tail: missing operand\n') })]
  }
  if (bytesMode !== null) {
    const out: ByteSource = bytesMode === 0 ? new Uint8Array(0) : raw.slice(-bytesMode)
    return [out, new IOResult()]
  }
  return [tailBytes(raw, lines, null, plusMode), new IOResult()]
}
