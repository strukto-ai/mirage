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

import { byteView, decodeText } from '../../../shell/bytes.ts'
import { isStdin } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { AWK_USAGE } from '../constants.ts'
import { type AwkFlags } from './awk_types.ts'
import { openStream, serveRequests, type OpenStream } from '../../../rs/stream.ts'
import { StreamHost } from '../utils/stream_host.ts'

import { fsStrerror, isEnotdir, isMissingPath } from '../../../errors/fs.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { mountsOf, mountRoot } from '../utils/links.ts'

const ENC = new TextEncoder()

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

function parseFlags(ctx: Context): AwkFlags {
  const fl = new FlagView(ctx.flags, specOf('awk'))
  const assignments = fl.asList('v')
  const programFiles = fl.asPaths('f')
  return {
    fieldSeparator: fl.asStr('F') ?? null,
    assignments,
    programFiles,
  }
}

/** Whether an operand is a `var=value` assignment, not a file: POSIX makes
 * it one when a name comes before its `=`. Mirrors Python's `is_assignment`. */
export function isAssignment(operand: string): boolean {
  return ASSIGNMENT.test(operand)
}

/** The operand whose mount runs the program: its first file. Mirrors
 * Python's `home_operand`. */
export function homeOperand(scopes: readonly PathSpec[]): PathSpec | null {
  for (const scope of scopes) {
    if (scope.rawPath !== '' && !isStdin(scope) && !isAssignment(scope.rawPath)) {
      return scope
    }
  }
  return scopes[0] ?? null
}

/**
 * Whether the mount awk runs on serves an operand. A line whose operands span
 * mounts runs awk once, on its first file's mount; an operand another mount
 * serves is read through the dispatcher. Outside a workspace (no name plane)
 * every operand is the mount's own.
 */
export function servedHere(ctx: Context, path: PathSpec): boolean {
  const mounts = mountsOf(ctx)
  if (mounts === undefined) return true
  const home = mountRoot(ctx)
  return mounts.rootOf(path.virtual).replace(/\/+$/, '') === home
}

/** Run the program, yielding standard output as it settles. */
async function* awkStream(
  stream: OpenStream,
  host: StreamHost,
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  try {
    yield* serveRequests(stream, host, signal)
    io.exitCode = stream.status()
  } finally {
    io.stderr = await host.errors.output()
    await host.close()
    stream.close()
  }
}

export async function awkGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: Stream,
): Promise<CommandFnResult> {
  const f = parseFlags(ctx)
  const host = new StreamHost(paths, stream, ctx, true, '', (path) => servedHere(ctx, path))
  let program: string
  if (f.programFiles.length > 0) {
    const pieces: string[] = []
    for (const programFile of f.programFiles) {
      try {
        const source = isStdin(programFile) ? host.stdinView() : stream(programFile)
        pieces.push(decodeText(await materialize(source)))
      } catch (err) {
        // GNU awk exits 2 when a -f program file cannot be opened;
        // anything that is not absence keeps propagating.
        if (!isMissingPath(err) && !isEnotdir(err)) throw err
        const msg = `awk: ${programFile.rawPath}: ${fsStrerror(err) ?? posixPhrase('ENOENT')}`
        return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
      }
    }
    program = pieces.join('\n')
  } else if (texts.length > 0 && texts[0] !== undefined) {
    program = texts[0]
  } else {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${AWK_USAGE}\n`) })]
  }

  // An empty operand names no file and mawk skips it, as it does an
  // operand ARGV no longer holds; a `var=value` operand is assigned when
  // the input reaches it. FILENAME reports the operand as typed.
  const engine = await openStream('awk', {
    program: byteView(program),
    operands: paths.map((p) => byteView(p.rawPath)),
    assignments: f.assignments.map((a) => byteView(a)),
    fs: f.fieldSeparator === null ? null : byteView(f.fieldSeparator),
    environ: Object.entries(ctx.env ?? {}).map(([name, value]) => byteView(`${name}=${value}`)),
  })
  if (!engine.busy()) {
    const stderr = engine.takeStderr()
    engine.close()
    return [null, new IOResult({ exitCode: 2, stderr })]
  }
  const io = new IOResult()
  return [awkStream(engine, host, io, ctx.signal), io]
}
