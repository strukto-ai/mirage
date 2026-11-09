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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveSource } from '../utils/stream.ts'
import { byteView, fromByteView } from '../../../shell/bytes.ts'
import { FlagView } from '../../spec/flag_view.ts'

const ENC = new TextEncoder()
// How much of an unfinished reference is held for the next chunk; past this a
// name is no name anyone wrote, and it passes as text.
const MAX_HELD = 64 * 1024
const MISSING = ENC.encode('envsubst: missing arguments\n')
const TOO_MANY = ENC.encode('envsubst: too many arguments\n')
const REFERENCE = /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g
const UNFINISHED = /^\$\{?[A-Za-z0-9_]*$/

function names(shellFormat: string): string[] {
  return [...shellFormat.matchAll(REFERENCE)].map((found) => found[1] ?? found[2] ?? '')
}

function replacer(
  env: Readonly<Record<string, string>>,
  allowed: ReadonlySet<string> | null,
): (text: string) => string {
  return (text) =>
    text.replace(REFERENCE, (whole: string, plain?: string, braced?: string) => {
      const name = plain ?? braced ?? ''
      if (allowed !== null && !allowed.has(name)) return whole
      return byteView(env[name] ?? '')
    })
}

async function* substituted(
  source: AsyncIterable<Uint8Array>,
  replace: (text: string) => string,
): AsyncGenerator<Uint8Array> {
  let held = ''
  for await (const chunk of source) {
    const data = held + byteView(chunk)
    const at = data.lastIndexOf('$')
    const keep = at >= 0 && data.length - at <= MAX_HELD && UNFINISHED.test(data.slice(at))
    held = keep ? data.slice(at) : ''
    const done = keep ? data.slice(0, at) : data
    if (done !== '') yield fromByteView(replace(done))
  }
  if (held !== '') yield fromByteView(replace(held))
}

// Replace $NAME and ${NAME} on standard input; a SHELL-FORMAT operand limits
// which names, and -v lists a format's names. Pinned against gettext-runtime
// 0.23.1.
function envsubst(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  if (texts.length > 1) return [null, new IOResult({ exitCode: 1, stderr: TOO_MANY })]
  const fl = new FlagView(ctx.flags, specOf('envsubst'))
  const picked = texts[0] === undefined ? null : byteView(texts[0])
  if (fl.asBool('variables')) {
    if (picked === null) return [null, new IOResult({ exitCode: 1, stderr: MISSING })]
    const lines = names(picked).map((name) => `${name}\n`)
    return [lines.length > 0 ? fromByteView(lines.join('')) : null, new IOResult()]
  }
  const allowed = picked === null ? null : new Set(names(picked))
  return [substituted(resolveSource(ctx.stdin), replacer(ctx.env ?? {}, allowed)), new IOResult()]
}

export const GENERAL_ENVSUBST = command({
  name: 'envsubst',
  vfs: null,
  spec: specOf('envsubst'),
  fn: envsubst,
})
