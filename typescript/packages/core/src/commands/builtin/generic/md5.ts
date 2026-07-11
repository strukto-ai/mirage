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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { md5Hex } from '../../../utils/hash.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { formatRecords } from '../utils/output.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'

export async function md5Generic(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const lines: string[] = []
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the good hashes still
    // print (GNU md5sum).
    const [ok, err] = await readOperands(paths, stream, 'md5')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    for (const o of ok) lines.push(`${md5Hex(o.data)}  ${o.path.rawPath}`)
    const out: ByteSource = formatRecords(lines)
    return [out, io]
  }
  if (opts.stdin !== null) {
    const data = await materialize(opts.stdin)
    lines.push(`${md5Hex(data)}  -`)
  }
  const out: ByteSource = formatRecords(lines)
  return [out, new IOResult()]
}
