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
  IOResult,
  materialize,
  type ByteSource,
  type CLIInvocation,
  type CommandFnResult,
} from '@struktoai/mirage-core'
import type { EmailConfig } from '../../../../core/email/config.ts'
import { sendRaw } from './smtp.ts'

const ENC = new TextEncoder()

export async function send(inv: CLIInvocation): Promise<CommandFnResult> {
  // The operand is a whole RFC 5322 message, so tokens rejoin with a
  // space and literal \n become real line breaks, the way upstream's
  // MessageArg resolves an inline message.
  const inline = inv.texts.join(' ').replaceAll('\\r', '').replaceAll('\\n', '\n')
  const raw =
    inline !== ''
      ? ENC.encode(inline)
      : inv.stdin !== null
        ? await materialize(inv.stdin)
        : new Uint8Array()
  if (new TextDecoder().decode(raw).trim() === '') {
    throw new Error('no message provided: pass it as an argument or pipe it via standard input')
  }
  const parsed = await sendRaw(inv.config as EmailConfig, raw)
  const result = {
    status: 'sent',
    to: parsed.to
      .map((entry) => (entry.name === '' ? entry.email : `${entry.name} <${entry.email}>`))
      .join(', '),
    subject: parsed.subject,
  }
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}
