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

import {
  concatBytes,
  evalJsonlStream,
  formatJqOutput,
  isJsonlPath,
  isStreamableJsonlExpr,
  jqEval,
  parseJsonAuto,
  parseJsonPath,
} from '../../../core/jq/index.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

export async function jqGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  // GNU jq defaults the filter to "." when no expression is given
  const expression = texts[0] ?? '.'
  const raw = opts.flags.r === true
  const compact = opts.flags.c === true
  const slurp = opts.flags.s === true

  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    if (isJsonlPath(first.virtual) && isStreamableJsonlExpr(expression)) {
      return [evalJsonlStream(stream(first), expression, raw), new IOResult()]
    }
    const outputs: Uint8Array[] = []
    const spread = expression.includes('[]')
    for (const p of paths) {
      const bytes = await materialize(stream(p))
      let data = parseJsonPath(bytes, p.virtual)
      if (isJsonlPath(p.virtual) && Array.isArray(data) && !slurp) {
        for (const item of data) {
          const result = await jqEval(item, expression.trim())
          outputs.push(formatJqOutput(result, raw, compact, spread))
        }
        continue
      }
      if (slurp && !Array.isArray(data)) data = [data]
      const result = await jqEval(data, expression.trim())
      outputs.push(formatJqOutput(result, raw, compact, spread))
    }
    const out: ByteSource = concatBytes(outputs)
    return [out, new IOResult()]
  }

  const stdinBytes = await readStdinAsync(opts.stdin)
  if (stdinBytes === null) return [null, new IOResult()]
  let stdinData = parseJsonAuto(stdinBytes)
  if (slurp && !Array.isArray(stdinData)) stdinData = [stdinData]
  const stdinResult = await jqEval(stdinData, expression.trim())
  const stdinSpread = expression.includes('[]')
  return [formatJqOutput(stdinResult, raw, compact, stdinSpread), new IOResult()]
}
