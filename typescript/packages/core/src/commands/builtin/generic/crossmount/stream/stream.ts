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
import { IOResult, type ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { type CrossResult, type RunSingle } from '../types.ts'

function hasActiveFlags(flagKwargs: Record<string, string | boolean | string[]>): boolean {
  return Object.values(flagKwargs).some((v) => v !== false)
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
  cmdName: string,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, string | boolean | string[]>,
  runSingle: RunSingle,
): Promise<CrossResult> {
  let mergedIo = new IOResult()
  const sources: ByteSource[] = []
  let failed = false
  for (const scope of scopes) {
    const [out, io] = await runSingle('cat', [scope], [], {})
    mergedIo = await mergedIo.merge(io)
    if (io.exitCode !== 0) {
      failed = true
      continue
    }
    if (out !== null) sources.push(out)
  }
  const body: ByteSource = asyncChain(...sources)

  if (cmdName === 'cat' && !hasActiveFlags(flagKwargs)) {
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
