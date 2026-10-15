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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { reportedStream } from '../utils/operands.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

interface LookFlags {
  readonly foldCase: boolean
}

function parseFlags(bag: Record<string, FlagValue>): LookFlags {
  const fl = new FlagView(bag, specOf('look'))
  return { foldCase: fl.asBool('f') }
}

export function lookGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  if (paths.length > 1) throw extraOperandError(CommandName.LOOK, paths[1]?.rawPath ?? '')
  if (texts.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('look: missing prefix\n') })]
  }
  const prefix = texts[0] ?? ''
  const caseInsensitive = parseFlags(opts.flags).foldCase
  const io = new IOResult({ exitCode: 1 })
  const path = paths[0]
  const source = path === undefined ? (opts.stdin ?? new Uint8Array()) : stream(path)
  const output = lookStream(source, prefix, caseInsensitive, io)
  return [path === undefined ? output : reportedStream(output, io, path, 'look'), io]
}

async function* lookStream(
  source: ByteSource,
  prefix: string,
  foldCase: boolean,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  const cmpPrefix = foldCase ? prefix.toLowerCase() : prefix
  const reader = new AsyncLineIterator(source)
  try {
    for await (const raw of reader) {
      const line = DEC.decode(raw)
      const cmpLine = foldCase ? line.toLowerCase() : line
      if (cmpLine.startsWith(cmpPrefix)) {
        io.exitCode = 0
        yield ENC.encode(line + '\n')
      }
    }
  } finally {
    await reader.discard()
  }
}
