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

import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

export type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>
export type Hasher = (bytes: Uint8Array) => Promise<string>

async function hashStream(source: AsyncIterable<Uint8Array>, hasher: Hasher): Promise<string> {
  return hasher(await materialize(source))
}

async function* singleStream(
  source: AsyncIterable<Uint8Array>,
  label: string,
  hasher: Hasher,
): AsyncIterable<Uint8Array> {
  const digest = await hashStream(source, hasher)
  yield ENC.encode(`${digest}  ${label}\n`)
}

function makePathSpec(virtual: string, mountPrefix: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: mountKey(virtual, mountPrefix),
    resolved: true,
  })
}

async function checkFile(
  stream: Stream,
  p: PathSpec,
  hasher: Hasher,
): Promise<[Uint8Array, number]> {
  const data = DEC.decode(await materialize(stream(p)))
  const mountPrefix = mountPrefixOf(p.virtual, p.resourcePath)
  const lines: string[] = []
  let failed = false
  for (const line of data.split('\n')) {
    if (line.trim() === '') continue
    const idx = line.indexOf('  ')
    if (idx < 0) continue
    const expected = line.slice(0, idx)
    const filename = line.slice(idx + 2)
    const digest = await hashStream(stream(makePathSpec(filename, mountPrefix)), hasher)
    if (digest === expected) lines.push(`${filename}: OK`)
    else {
      lines.push(`${filename}: FAILED`)
      failed = true
    }
  }
  return [ENC.encode(lines.join('\n') + '\n'), failed ? 1 : 0]
}

export async function checksumGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: Stream,
  hasher: Hasher,
  name: string,
): Promise<CommandFnResult> {
  const check = opts.flags.c === true
  if (check && paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    const [out, exitCode] = await checkFile(stream, first, hasher)
    const result: ByteSource = out
    return [result, new IOResult({ exitCode })]
  }
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the good hashes still
    // print (GNU coreutils checksum commands).
    const [ok, err] = await readOperands(paths, stream, name)
    const io = operandsIo(err, { cache: ok.map((o) => o.path.mountPath) })
    if (ok.length === 0 && err !== '') return [null, io]
    let body = ''
    for (const o of ok) body += `${await hasher(o.data)}  ${o.path.rawPath}\n`
    const result: ByteSource = ENC.encode(body)
    return [result, io]
  }
  const source: AsyncIterable<Uint8Array> = resolveSource(opts.stdin)
  return [singleStream(source, '-', hasher), new IOResult()]
}
