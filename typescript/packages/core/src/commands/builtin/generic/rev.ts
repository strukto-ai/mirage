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

import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { stdinStream } from '../utils/stream.ts'
import { reportedStream } from '../utils/operands.ts'
import { asyncChain } from '../../../io/stream.ts'
import { mapStream } from '../utils/lines.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

function reversed(line: Uint8Array): Uint8Array {
  return ENC.encode(Array.from(DEC.decode(line)).reverse().join(''))
}

export function revGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, opts.stdin, false, false)
  const io = new IOResult()
  const sources = paths.map((p) => reportedStream(stream(p), io, p, 'rev'))
  const output =
    paths.length > 0
      ? asyncChain(sources.map((source) => mapStream(source, reversed)))
      : mapStream(opts.stdin ?? new Uint8Array(), reversed)
  return [output, io]
}
