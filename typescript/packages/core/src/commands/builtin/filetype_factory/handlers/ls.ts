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
import type { FiletypeEntry, ReadBytesFn, StatEntryFn } from '../extensions.ts'

const ENC = new TextEncoder()

export async function ftLs<A extends Accessor>(
  readBytes: ReadBytesFn<A>,
  statEntry: StatEntryFn<A>,
  entry: FiletypeEntry,
  accessor: A,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const [first] = paths
  if (first === undefined) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('ls: missing operand\n') })]
  }
  const stat = await statEntry(accessor, first, opts.index ?? undefined)
  const meta = { size: stat.size ?? 0, modified: stat.modified, name: stat.name }
  try {
    const raw = await readBytes(accessor, first, opts.index ?? undefined)
    const out: ByteSource = await entry.module.ls(raw, meta)
    return [out, new IOResult({ cache: [first.mountPath] })]
  } catch {
    return [entry.module.lsFallback(meta), new IOResult()]
  }
}
