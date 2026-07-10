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

export async function md5Generic(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const lines: string[] = []
  if (paths.length > 0) {
    for (const p of paths) {
      const data = await materialize(stream(p))
      lines.push(`${md5Hex(data)}  ${p.rawPath}`)
    }
  } else if (opts.stdin !== null) {
    const data = await materialize(opts.stdin)
    lines.push(`${md5Hex(data)}  -`)
  }
  const out: ByteSource = formatRecords(lines)
  return [out, new IOResult()]
}
