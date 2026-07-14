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
import { IOResult, materialize, type ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { Cmd, type CrossResult, type RunSingle } from '../types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function hasActiveFlags(flagKwargs: Record<string, string | boolean | string[]>): boolean {
  return Object.values(flagKwargs).some((v) => v !== false)
}

// The per-operand fetch is a native Cmd.CAT sub-run, so its error lines
// carry the fetch command's prefix; respell them to the real command so the
// cross-mount bytes match single-mount.
function respellFetchStderr(stderr: Uint8Array, cmdName: string): Uint8Array {
  const fetchPrefix = `${Cmd.CAT}: `
  const lines = DEC.decode(stderr).split('\n')
  const respelled = lines.map((line) =>
    line.startsWith(fetchPrefix) ? `${cmdName}: ${line.slice(fetchPrefix.length)}` : line,
  )
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
  flagKwargs: Record<string, string | boolean | string[]>,
  runSingle: RunSingle,
): Promise<CrossResult> {
  let mergedIo = new IOResult()
  const sources: ByteSource[] = []
  let failed = false
  for (const scope of scopes) {
    const [out, io] = await runSingle(Cmd.CAT, [scope], [], {})
    if (io.exitCode !== 0) {
      failed = true
      if (cmdName !== Cmd.CAT && io.stderr !== null) {
        io.stderr = respellFetchStderr(await materialize(io.stderr), cmdName)
      }
      mergedIo = await mergedIo.merge(io)
      continue
    }
    mergedIo = await mergedIo.merge(io)
    if (out !== null) sources.push(out)
  }
  // sort aborts on any failed operand like GNU (it needs every input
  // before emitting anything), matching the single-mount builder.
  if (failed && cmdName === Cmd.SORT) {
    mergedIo.exitCode = mergedIo.exitCode || 1
    return [null, mergedIo]
  }

  const body: ByteSource = asyncChain(...sources)

  if (cmdName === Cmd.CAT && !hasActiveFlags(flagKwargs)) {
    if (failed) mergedIo.exitCode = mergedIo.exitCode || 1
    return [body, mergedIo]
  }

  const [out, io] = await runSingle(cmdName, [], [...textArgs], flagKwargs, {
    stdin: body,
    resolveHint: scopes[0] ?? null,
  })
  mergedIo = await mergedIo.merge(io)
  if (failed) mergedIo.exitCode = mergedIo.exitCode || 1
  return [out, mergedIo]
}
