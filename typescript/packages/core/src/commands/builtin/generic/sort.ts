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
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { parseKeyOptions, sortAndDedupe, splitSortLines } from '../sort_helper.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

export async function sortGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const keyOpts = parseKeyOptions(opts.flags)
  const reverse = opts.flags.r === true
  const unique = opts.flags.u === true
  let allLines: string[] = []
  if (paths.length > 0) {
    for (const p of paths) {
      const data = DEC.decode(await materialize(stream(p)))
      allLines = allLines.concat(splitSortLines(data))
    }
  } else {
    const raw = await readStdinAsync(opts.stdin)
    allLines = splitSortLines(DEC.decode(raw ?? new Uint8Array(0)))
  }
  const sorted = sortAndDedupe(allLines, keyOpts, reverse, unique)
  const out: ByteSource =
    sorted.length === 0 ? new Uint8Array(0) : ENC.encode(sorted.join('\n') + '\n')
  return [out, new IOResult()]
}
