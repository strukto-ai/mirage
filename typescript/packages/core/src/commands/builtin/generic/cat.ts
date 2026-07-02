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

import { CachableAsyncIterator } from '../../../io/cachable_iterator.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ProvisionResult } from '../../../provision/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const NL = 0x0a

type Stat = (p: PathSpec) => Promise<FileStat>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

function formatLineNo(n: number): string {
  return String(n).padStart(6, ' ')
}

/**
 * Number lines like GNU `cat -n`: a 6-wide right-justified count followed by a
 * tab, then the line. A final line with no trailing newline keeps its missing
 * newline (no spurious `\n` is appended).
 */
export async function* numberLines(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let lineNo = 0
  let buf = new Uint8Array(0)
  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue
    const merged = new Uint8Array(buf.byteLength + chunk.byteLength)
    merged.set(buf, 0)
    merged.set(chunk, buf.byteLength)
    buf = merged
    let nl = buf.indexOf(NL)
    while (nl >= 0) {
      lineNo += 1
      yield ENC.encode(`${formatLineNo(lineNo)}\t`)
      yield buf.subarray(0, nl + 1)
      buf = buf.subarray(nl + 1)
      nl = buf.indexOf(NL)
    }
  }
  if (buf.byteLength > 0) {
    lineNo += 1
    yield ENC.encode(`${formatLineNo(lineNo)}\t`)
    yield buf
  }
}

export async function catProvisionGeneric(paths: PathSpec[], stat: Stat): Promise<ProvisionResult> {
  const [first] = paths
  if (first === undefined) return new ProvisionResult({ command: 'cat' })
  try {
    const s = await stat(first)
    return new ProvisionResult({
      command: `cat ${first.virtual}`,
      networkReadLow: s.size ?? 0,
      networkReadHigh: s.size ?? 0,
      readOps: 1,
    })
  } catch {
    return new ProvisionResult({ command: 'cat' })
  }
}

async function* chainStreams(
  streams: readonly AsyncIterable<Uint8Array>[],
): AsyncIterable<Uint8Array> {
  for (const s of streams) {
    for await (const chunk of s) yield chunk
  }
}

export async function catGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: Stat,
  stream: Stream,
): Promise<CommandFnResult> {
  const nFlag = opts.flags.n === true
  if (paths.length > 0) {
    for (const p of paths) await stat(p)
    const reads: Record<string, ByteSource> = {}
    const cacheKeys: string[] = []
    const outputs: AsyncIterable<Uint8Array>[] = []
    for (const p of paths) {
      const cachable = new CachableAsyncIterator(stream(p))
      reads[p.mountPath] = cachable
      cacheKeys.push(p.mountPath)
      outputs.push(cachable)
    }
    const merged = chainStreams(outputs)
    const out: ByteSource = nFlag ? numberLines(merged) : merged
    return [out, new IOResult({ reads, cache: cacheKeys })]
  }
  try {
    const source = resolveSource(opts.stdin, 'cat: missing operand')
    const out: ByteSource = nFlag ? numberLines(source) : source
    return [out, new IOResult()]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
}
