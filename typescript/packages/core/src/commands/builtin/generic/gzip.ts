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

import { stripSlash } from '../../../utils/slash.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { gzip, gunzip } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()

function makePathSpec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
    resolved: true,
  })
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

export async function gzipGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  unlink: (p: PathSpec) => Promise<void>,
): Promise<CommandFnResult> {
  const decompress = opts.flags.d === true
  const keep = opts.flags.k === true
  const stdoutMode = opts.flags.c === true

  if (paths.length === 0) {
    let source: AsyncIterable<Uint8Array>
    try {
      source = decompress
        ? resolveSource(opts.stdin, 'gzip: (stdin): unexpected end of file')
        : resolveSource(opts.stdin)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
    }
    const data = await materialize(source)
    const out = decompress ? await gunzip(data) : await gzip(data)
    const result: ByteSource = out
    return [result, new IOResult()]
  }

  if (stdoutMode) {
    const chunks: Uint8Array[] = []
    for (const p of paths) {
      const raw = await materialize(stream(p))
      const out = decompress ? await gunzip(raw) : await gzip(raw)
      chunks.push(out)
    }
    return [concat(chunks), new IOResult()]
  }

  const writes: Record<string, Uint8Array> = {}
  for (const p of paths) {
    const raw = await materialize(stream(p))
    const pStripped = p.mountPath
    let outPath: string
    let outData: Uint8Array
    if (decompress) {
      outPath = pStripped.endsWith('.gz') ? pStripped.slice(0, -3) : pStripped + '.out'
      outData = await gunzip(raw)
    } else {
      outPath = pStripped + '.gz'
      outData = await gzip(raw)
    }
    await write(makePathSpec(outPath), outData)
    writes[outPath] = outData
    if (!keep) await unlink(p)
  }
  return [null, new IOResult({ writes })]
}
