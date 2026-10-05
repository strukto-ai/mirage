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
import { IOResult, materialize } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import { decodeBase64, encodeBase64 } from '../../../utils/base64.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource, stdinStat, stdinStream } from '../utils/stream.ts'
import { splitReadable } from '../utils/operands.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { encodeText } from '../../../shell/bytes.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })

interface Base64Flags {
  readonly decode: boolean
  readonly wrap: number | null
  readonly ignoreGarbage: boolean
}

function parseFlags(bag: Record<string, FlagValue>): Base64Flags {
  const fl = new FlagView(bag, specOf('base64'))
  const wrapValue = fl.asStr('wrap')
  return {
    decode: fl.asBool('D') || fl.asBool('decode'),
    wrap: typeof wrapValue === 'string' ? Number.parseInt(wrapValue, 10) : null,
    ignoreGarbage: fl.asBool('ignore_garbage'),
  }
}

async function* base64EncodeStream(
  source: AsyncIterable<Uint8Array>,
  wrap: number | null,
): AsyncIterable<Uint8Array> {
  const buf = await materialize(source)
  const encoded = encodeBase64(buf)
  if (encoded === '') return
  if (wrap !== null && wrap === 0) {
    yield encodeText(encoded + '\n')
    return
  }
  const lineLen = wrap ?? 76
  const lines: string[] = []
  for (let i = 0; i < encoded.length; i += lineLen) {
    lines.push(encoded.slice(i, i + lineLen))
  }
  yield encodeText(lines.join('\n') + '\n')
}

async function* base64DecodeStream(
  source: AsyncIterable<Uint8Array>,
  ignoreGarbage: boolean,
): AsyncIterable<Uint8Array> {
  const buf = await materialize(source)
  let text = DEC.decode(buf).replace(/\s/g, '')
  if (ignoreGarbage) text = text.replace(/[^A-Za-z0-9+/=]/g, '')
  yield decodeBase64(text)
}

// The operand is stat'ed before the lazy encode starts, so a missing or
// unreadable one is reported in base64's own words (`base64: nope: No such
// file or directory`) instead of surfacing mid-drain. Mirrors Python's
// base64_generic.
export async function base64Generic(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stat: (p: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, opts.stdin)
  if (paths.length > 1) throw extraOperandError(CommandName.BASE64, paths[1]?.rawPath ?? '')
  if (paths.length === 1) {
    const [, err] = await splitReadable(paths, stdinStat(stat), 'base64')
    if (err !== '') return [null, new IOResult({ exitCode: 1, stderr: encodeText(err) })]
  }
  const parsed = parseFlags(opts.flags)
  let source: AsyncIterable<Uint8Array>
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    source = stream(first)
  } else {
    source = resolveSource(opts.stdin)
  }
  const out = parsed.decode
    ? base64DecodeStream(source, parsed.ignoreGarbage)
    : base64EncodeStream(source, parsed.wrap)
  return [out, new IOResult()]
}
