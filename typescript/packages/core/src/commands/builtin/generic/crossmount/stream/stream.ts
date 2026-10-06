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

import { asyncChain } from '../../../../../io/stream.ts'
import { readFailExitCodeFromLine } from '../../../../spec/usage.ts'
import { IOResult, materialize, type ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { revoiceFsErrorLine } from '../../../../../errors/render.ts'
import { LINE_STREAM_COMMANDS } from '../constants.ts'
import { Cmd, type CrossResult, type RunSingle } from '../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function hasActiveFlags(flagKwargs: Record<string, FlagValue>): boolean {
  return Object.values(flagKwargs).some((v) => v !== false)
}

// One operand's bytes, its last line ended where the file ends: what a line
// reader sees at a file boundary, so `ab` followed by the next file's `cd` is
// two lines, the way the single-mount commands join their operands. Mirrors
// Python's _line_ended.
async function* lineEnded(source: ByteSource): AsyncIterable<Uint8Array> {
  let last = 0x0a
  for await (const chunk of asyncChain([source])) {
    if (chunk.byteLength > 0) last = chunk[chunk.byteLength - 1] ?? 0x0a
    yield chunk
  }
  if (last !== 0x0a) yield Uint8Array.of(0x0a)
}

// The per-operand fetch is a native Cmd.CAT sub-run, so its error lines
// carry the fetch command's voice; each is said again in the real command's
// (its prefix, its quoting, the step it names) so the cross-mount bytes
// match single-mount.
function respellFetchStderr(stderr: Uint8Array, cmdName: string, scope: PathSpec): Uint8Array {
  const lines = DEC.decode(stderr).split('\n')
  const respelled = lines.map((line) => revoiceFsErrorLine(line, Cmd.CAT, cmdName, scope))
  return ENC.encode(respelled.join('\n'))
}

// Run a stream command (`cmd files...` == `cat files... | cmd`). Each
// operand's raw bytes come from a native flagless `cat` on its owning mount
// (which also expands the operand's glob natively); one native run of the
// real command then consumes the merged stream in its stdin mode, so every
// flag keeps its single-invocation semantics (continuous `cat -n`/`nl`
// numbering, one global `sort` order, one `sed` address space). A failed
// operand is skipped and reported on stderr, cat-style; the merged exit code
// is then non-zero.
export async function runStream(
  cmdName: Cmd,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  runSingle: RunSingle,
): Promise<CrossResult> {
  let mergedIo = new IOResult()
  const sources: ByteSource[] = []
  let failed = false
  // The real command's code for the worst failed fetch. The fetch runs as
  // Cmd.CAT, so its own code is cat's 1 whatever went wrong; the stderr is
  // already respelled into the real command's voice and the code has to
  // follow it, or `sort a /other/missing` answers 1 while `sort missing`
  // answers 2.
  let failCode = 0
  for (const scope of scopes) {
    const [out, io] = await runSingle(Cmd.CAT, [scope], [], {})
    if (io.exitCode !== 0) {
      failed = true
      if (io.stderr !== null) {
        let rendered = await materialize(io.stderr)
        if (cmdName !== Cmd.CAT) {
          rendered = respellFetchStderr(rendered, cmdName, scope)
          io.stderr = rendered
        }
        failCode = Math.max(failCode, readFailExitCodeFromLine(cmdName, DEC.decode(rendered)))
      }
      // The fetch ran as cat, so its exit code is cat's whatever went
      // wrong. failCode already carries the real command's, and merging
      // cat's over it would win the `||` below.
      io.exitCode = 0
      mergedIo = await mergedIo.merge(io)
      continue
    }
    mergedIo = await mergedIo.merge(io)
    if (out !== null) sources.push(out)
  }
  // sort aborts on any failed operand like GNU (it needs every input
  // before emitting anything), matching the single-mount builder.
  if (failed && cmdName === Cmd.SORT) {
    mergedIo.exitCode = mergedIo.exitCode || failCode || 1
    return [null, mergedIo]
  }

  const merged =
    LINE_STREAM_COMMANDS.has(cmdName) && sources.length > 0
      ? [...sources.slice(0, -1).map(lineEnded), ...sources.slice(-1)]
      : sources
  const body: ByteSource = asyncChain(merged)

  if (cmdName === Cmd.CAT && !hasActiveFlags(flagKwargs)) {
    if (failed) mergedIo.exitCode = mergedIo.exitCode || failCode || 1
    return [body, mergedIo]
  }

  const [out, io] = await runSingle(cmdName, [], [...textArgs], flagKwargs, {
    stdin: body,
    resolveHint: scopes[0] ?? null,
  })
  mergedIo = await mergedIo.merge(io)
  if (failed) mergedIo.exitCode = mergedIo.exitCode || failCode || 1
  return [out, mergedIo]
}
