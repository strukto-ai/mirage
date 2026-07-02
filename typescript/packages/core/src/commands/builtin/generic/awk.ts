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

import { mountKey, mountPrefixOf, stripMount } from '../../../utils/key_prefix.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { awkStream } from './awk_helper.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

export async function awkGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  const fFlag = typeof opts.flags.f === 'string' ? opts.flags.f : null
  let program: string
  let dataPaths: string[]
  if (fFlag !== null) {
    const programPath = fFlag
    const mountPrefix =
      (paths[0] === undefined
        ? undefined
        : mountPrefixOf(paths[0].virtual, paths[0].resourcePath)) ??
      opts.mountPrefix ??
      ''
    const programSpec = PathSpec.fromStrPath(programPath, mountKey(programPath, mountPrefix))
    try {
      program = DEC.decode(await materialize(stream(programSpec))).trim()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
    }
    dataPaths = [...texts.map((t) => stripMount(t, mountPrefix)), ...paths.map((p) => p.mountPath)]
  } else if (texts.length > 0 && texts[0] !== undefined) {
    program = texts[0]
    dataPaths = paths.map((p) => p.mountPath)
  } else {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode(`awk: usage: awk [-F fs] [-v var=val] 'program' [file ...]\n`),
      }),
    ]
  }
  const fs = typeof opts.flags.F === 'string' ? opts.flags.F : ' '
  const variables: Record<string, string> = {}
  if (typeof opts.flags.v === 'string' && opts.flags.v.includes('=')) {
    const [key, val] = opts.flags.v.split('=', 2)
    if (key !== undefined && val !== undefined) variables[key] = val
  }
  const cache: string[] = []
  let source: AsyncIterable<Uint8Array>
  if (dataPaths.length > 0) {
    const firstPath = dataPaths[0]
    if (firstPath === undefined) return [null, new IOResult()]
    const spec = PathSpec.fromStrPath(firstPath)
    source = stream(spec)
    cache.push(firstPath)
  } else {
    source = resolveSource(opts.stdin)
  }
  return [awkStream(source, program, fs, variables), new IOResult({ cache })]
}
