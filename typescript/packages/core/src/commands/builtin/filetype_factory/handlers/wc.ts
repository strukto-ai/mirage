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

import type { Accessor } from '../../../../accessor/base.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../../config.ts'
import type { FiletypeEntry, FiletypeReadBytesFn, StatEntryFn } from '../extensions.ts'

const ENC = new TextEncoder()

export async function ftWc<A extends Accessor>(
  readBytes: FiletypeReadBytesFn<A>,
  _statEntry: StatEntryFn<A>,
  entry: FiletypeEntry,
  accessor: A,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('wc: missing operand\n') })]
  }
  const first = paths[0]
  if (first === undefined) return [null, new IOResult()]
  try {
    const raw = await readBytes(accessor, first, opts.index ?? undefined)
    const rows = await entry.module.wc(raw)
    const out: ByteSource = ENC.encode(`${String(rows)} ${first.virtual}\n`)
    return [out, new IOResult({ cache: [first.mountPath] })]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode(`wc: ${first.virtual}: failed to read as ${entry.fmt}: ${msg}\n`),
      }),
    ]
  }
}
