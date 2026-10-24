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

import type { CommandFnResult, Context } from '@struktoai/mirage-core/commands/config'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { FlagView } from '@struktoai/mirage-core/commands/spec/index'
import { IOResult, materialize } from '@struktoai/mirage-core/io/types'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import type { EmailAccessor } from '../../../../accessor/email.ts'
import { deliver } from './deliver.ts'
import { compactJsonBytes } from '@struktoai/mirage-core/core/render/json'

const ENC = new TextEncoder()

export async function send(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  // The operand is a whole RFC 5322 message, so tokens rejoin with a
  // space and literal \n become real line breaks, the way upstream's
  // MessageArg resolves an inline message.
  const inline = texts.join(' ').replaceAll('\\r', '').replaceAll('\\n', '\n')
  const raw =
    inline !== ''
      ? ENC.encode(inline)
      : ctx.stdin !== null
        ? await materialize(ctx.stdin)
        : new Uint8Array()
  if (new TextDecoder().decode(raw).trim() === '') {
    throw new Error('no message provided: pass it as an argument or pipe it via standard input')
  }
  const fl = new FlagView(ctx.flags)
  const { parsed, warning } = await deliver(accessor, raw, fl.asStr('save') ?? null)
  const result = {
    status: 'sent',
    to: parsed.to
      .map((entry) => (entry.name === '' ? entry.email : `${entry.name} <${entry.email}>`))
      .join(', '),
    subject: parsed.subject,
  }
  const out: ByteSource = compactJsonBytes(result)
  return [out, new IOResult({ stderr: warning === '' ? null : ENC.encode(warning) })]
}
