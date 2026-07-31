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
  parseJsonDocs,
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
    for (const p of paths) {
      const bytes = await materialize(stream(p))
      const docs = parseJsonDocs(bytes)
      if (slurp) {
        const values = await jqEval(docs, expression.trim())
        outputs.push(formatJqOutput(values, raw, compact))
        continue
      }
      // jq applies the program to every document in the stream, so a
      // multi-value file evaluates per document whatever it is named;
      // only slurp collapses the stream into one array.
      for (const doc of docs) {
        const values = await jqEval(doc, expression.trim())
        outputs.push(formatJqOutput(values, raw, compact))
      }
    }
    const out: ByteSource = concatBytes(outputs)
    return [out, new IOResult()]
  }

  const stdinBytes = await readStdinAsync(opts.stdin)
  if (stdinBytes === null) return [null, new IOResult()]
  const stdinDocs = parseJsonDocs(stdinBytes)
  if (slurp) {
    const slurped = await jqEval(stdinDocs, expression.trim())
    return [formatJqOutput(slurped, raw, compact), new IOResult()]
  }
  // Same stream rule as the path branch: piped input is a stream of
  // values, so each document is evaluated on its own.
  const stdinOut: Uint8Array[] = []
  for (const doc of stdinDocs) {
    const values = await jqEval(doc, expression.trim())
    stdinOut.push(formatJqOutput(values, raw, compact))
  }
  return [concatBytes(stdinOut), new IOResult()]
}
