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
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { awkStream } from './awk_helper.ts'
import { USAGE, type AwkFlags } from './awk_types.ts'
import { isMissingPath } from '../../../utils/errors.ts'
import { resolvePath } from '../../../utils/path.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

function parseFlags(opts: CommandOpts): AwkFlags {
  const fl = new FlagView(opts.flags, specOf('awk'))
  const assignments = fl.asList('v')
  const programFiles = fl.asList('f')
  return {
    fieldSeparator: fl.asStr('F') ?? null,
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
      // A relative -f resolves against the cwd, like the shell classifier
      // resolves python's PathSpec flag values.
      const virtual = resolvePath(programFile, opts.cwd)
      const programSpec = PathSpec.fromStrPath(virtual, mountKey(virtual, mountPrefix))
      try {
        pieces.push(DEC.decode(await materialize(stream(programSpec))).trim())
      } catch (err) {
        // GNU awk exits 2 when a -f program file cannot be opened;
        // anything that is not absence keeps propagating.
        if (!isMissingPath(err)) throw err
        const msg = `awk: ${programFile}: No such file or directory`
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
