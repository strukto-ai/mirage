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

import type { CommandFnResult, Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import { PathSpec as PathSpecClass } from '../../../../types.ts'
import { FlagView } from '../../../spec/index.ts'
import { IOResult, materialize, type ByteSource } from '../../../../io/types.ts'
import type { EmailAccessor } from '../../../../accessor/email.ts'
import type { Files } from '../../../../workspace/files.ts'
import { appendMessage } from './deliver.ts'
import { IMAP_FLAGS } from './flag.ts'
import { ChainedError, rendered } from './printer.ts'
import { sendRaw } from './smtp.ts'
import { finishMessage } from './util.ts'

const EMPTY_MESSAGE = 'Message is empty'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function crlf(data: Uint8Array): Uint8Array {
  const out: number[] = []
  data.forEach((byte, index) => {
    if (byte === 0x0a && (index === 0 || data[index - 1] !== 0x0d)) out.push(0x0d)
    out.push(byte)
  })
  return Uint8Array.from(out)
}

async function readMessage(
  vfs: Files | undefined,
  texts: string[],
  stdin: ByteSource | null,
  cwd: PathSpec,
): Promise<Uint8Array> {
  if (texts.length > 0) {
    const inline = texts.join(' ').replace(/\\r/g, '').replace(/\\n/g, '\r\n')
    if (vfs !== undefined) {
      const path = PathSpecClass.fromStrPath(inline, cwd.virtual)
      if (await vfs.exists(path)) return crlf(await vfs.read(path))
    }
    return crlf(ENC.encode(inline))
  }
  return stdin === null ? new Uint8Array(0) : await materialize(stdin)
}

function isBlank(raw: Uint8Array): boolean {
  return DEC.decode(raw).trim() === ''
}

export async function send(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const raw = await readMessage(ctx.vfs, texts, ctx.stdin, ctx.cwd)
  if (isBlank(raw)) throw new Error(EMPTY_MESSAGE)
  return finishMessage(accessor, fl, raw, true)
}

export async function add(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const raw = await readMessage(ctx.vfs, texts, ctx.stdin, ctx.cwd)
  if (isBlank(raw)) throw new Error(EMPTY_MESSAGE)
  const flags = fl.asList('flag').map((name) => IMAP_FLAGS[name] ?? name)
  const sent = fl.asBool('send')
  if (sent) await sendRaw(accessor.config, raw)
  const mailbox = fl.asStr('mailbox') ?? ''
  let uid: string | null
  try {
    uid = await appendMessage(accessor, raw, mailbox, flags)
  } catch (error) {
    if (!sent) throw error
    throw new ChainedError(`Message sent, but saving a copy to ${mailbox} failed`, [
      error instanceof Error ? error.message : String(error),
    ])
  }
  const suffix = sent ? ' and sent' : ''
  const text =
    uid !== null
      ? `Message ${uid} successfully added${suffix}`
      : `Message successfully added${suffix}, id unavailable`
  return [rendered(fl, { id: uid, sent }, text), new IOResult()]
}
