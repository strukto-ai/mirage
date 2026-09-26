import { decompressInputs } from './decompress.ts'
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
import { FlagView } from '../../spec/flag_view.ts'
import { mountedPath } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { gzip } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource, stdinStream } from '../utils/stream.ts'

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
  const fl = new FlagView(opts.flags, specOf('gzip'))
  const decompress = fl.asBool('d')
  const keep = fl.asBool('k')
  const stdoutMode = fl.asBool('c')

  if (decompress)
    return decompressInputs(paths, stream, {
      command: 'gzip',
      stdin: opts.stdin,
      keep,
      toStdout: stdoutMode,
      write,
      unlink,
    })
  if (paths.length === 0) {
    const result: ByteSource = await gzip(await materialize(resolveSource(opts.stdin)))
    return [result, new IOResult()]
  }
  const read = stdinStream(stream, opts.stdin)
  const writes: Record<string, Uint8Array> = {}
  const stdout: Uint8Array[] = []
  for (const p of paths) {
    const inPlace = !(stdoutMode || p.rawPath === '-')
    const raw = await materialize(inPlace ? stream(p) : read(p))
    const data = await gzip(raw)
    if (!inPlace) {
      stdout.push(data)
      continue
    }
    const pStripped = p.mountPath
    const outPath = pStripped + '.gz'
    await write(mountedPath(p, outPath), data)
    writes[outPath] = data
    if (!keep) await unlink(p)
  }
  return [stdout.length > 0 ? concat(stdout) : null, new IOResult({ writes })]
}
