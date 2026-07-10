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
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { awkStream } from './awk_helper.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

const USAGE = "awk: usage: awk [-F fs] [-v var=val] 'program' [file ...]"

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

interface AwkFlags {
  readonly fieldSeparator: string | null
  readonly assignments: readonly string[]
  readonly programFiles: readonly string[]
}

function parseFlags(opts: CommandOpts): AwkFlags {
  const rawV = opts.flags.v
  const assignments = Array.isArray(rawV) ? rawV : typeof rawV === 'string' ? [rawV] : []
  const rawF = opts.flags.f
  const programFiles = Array.isArray(rawF) ? rawF : typeof rawF === 'string' ? [rawF] : []
  return {
    fieldSeparator: typeof opts.flags.F === 'string' ? opts.flags.F : null,
    assignments,
    programFiles,
  }
}

export async function awkGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  const f = parseFlags(opts)
  let program: string
  if (f.programFiles.length > 0) {
    const mountPrefix =
      (paths[0] === undefined
        ? undefined
        : mountPrefixOf(paths[0].virtual, paths[0].resourcePath)) ??
      opts.mountPrefix ??
      ''
    const pieces: string[] = []
    for (const programFile of f.programFiles) {
      const programSpec = PathSpec.fromStrPath(programFile, mountKey(programFile, mountPrefix))
      try {
        pieces.push(DEC.decode(await materialize(stream(programSpec))).trim())
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
      }
    }
    program = pieces.join('\n')
  } else if (texts.length > 0 && texts[0] !== undefined) {
    program = texts[0]
  } else {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${USAGE}\n`) })]
  }

  const variables: Record<string, string> = {}
  for (const assignment of f.assignments) {
    const eq = assignment.indexOf('=')
    if (eq > 0) variables[assignment.slice(0, eq)] = assignment.slice(eq + 1)
  }

  let sources: AsyncIterable<Uint8Array>[]
  let cache: string[]
  if (paths.length > 0) {
    sources = paths.map((p) => stream(p))
    cache = paths.map((p) => p.mountPath)
  } else {
    sources = [resolveSource(opts.stdin)]
    cache = []
  }
  return [awkStream(sources, program, f.fieldSeparator, variables), new IOResult({ cache })]
}
