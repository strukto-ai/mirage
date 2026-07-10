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
import { sha256Hex } from '../../../utils/hash.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

async function hashStream(source: AsyncIterable<Uint8Array>): Promise<string> {
  const data = await materialize(source)
  return sha256Hex(data)
}

async function* sha256SingleStream(
  source: AsyncIterable<Uint8Array>,
  label: string,
): AsyncIterable<Uint8Array> {
  const digest = await hashStream(source)
  yield ENC.encode(`${digest}  ${label}\n`)
}

async function* sha256Multi(stream: Stream, paths: readonly PathSpec[]): AsyncIterable<Uint8Array> {
  for (const p of paths) {
    const digest = await hashStream(stream(p))
    yield ENC.encode(`${digest}  ${p.rawPath}\n`)
  }
}

function makePathSpec(virtual: string, mountPrefix: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: mountKey(virtual, mountPrefix),
    resolved: true,
  })
}

async function sha256Check(stream: Stream, p: PathSpec): Promise<[Uint8Array, number]> {
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
    const digest = await hashStream(stream(makePathSpec(filename, mountPrefix)))
    if (digest === expected) lines.push(`${filename}: OK`)
    else {
      lines.push(`${filename}: FAILED`)
      failed = true
    }
  }
  return [ENC.encode(lines.join('\n') + '\n'), failed ? 1 : 0]
}

export async function sha256sumGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  const check = opts.flags.c === true
  if (check && paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    const [out, exitCode] = await sha256Check(stream, first)
    const result: ByteSource = out
    return [result, new IOResult({ exitCode })]
  }
  if (paths.length > 0) {
    return [sha256Multi(stream, paths), new IOResult({ cache: paths.map((p) => p.mountPath) })]
  }
  const source: AsyncIterable<Uint8Array> = resolveSource(opts.stdin)
  return [sha256SingleStream(source, '-'), new IOResult()]
}
