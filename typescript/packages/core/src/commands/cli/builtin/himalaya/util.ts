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

import type { CommandFnResult } from '../../../config.ts'
import type { FlagView } from '../../../spec/index.ts'
import { compactJsonBytes } from '../../../../core/render/json.ts'
import { fsStrerror, isEnotdir, isMissingPath } from '../../../../errors/fs.ts'
import { posixPhrase } from '../../../../errors/posix.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import { mimeTypeFor } from '../../../../utils/filetype.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import type { Files } from '../../../../workspace/files.ts'
import type { EmailAccessor } from '../../../../accessor/email.ts'
import type { fromParsed } from '../../../../core/email/_parse.ts'
import { parseRfc822 } from '../../../../core/email/_parse.ts'
import { build, readBody, splitAddresses, type Attachment, type Source } from './builder.ts'
import { deliver, saveSentCopy } from './deliver.ts'

const ENC = new TextEncoder()

/** The `to` field both outcomes report, spelled as the header reads. */
function addressList(addresses: ReturnType<typeof fromParsed>['to']): string {
  return addresses
    .map((entry) => (entry.name === '' ? entry.email : `${entry.name} <${entry.email}>`))
    .join(', ')
}

/** The command's first operand, or a usage error. */
export function firstText(texts: readonly string[], label: string): string {
  const value = texts[0]
  if (value === undefined) throw new Error(`${label} is required`)
  return value
}

/**
 * Reads --attach files through the workspace dispatcher.
 *
 * An account CLI has no mount of its own; an attachment is an unrelated
 * workspace file, so it is read through the op dispatcher the executor
 * hands every CLI, the same entry point git reads repositories through. The
 * flag bag carries typed paths with their original directory walks.
 */
async function loadAttachments(
  vfs: Files | undefined,
  paths: readonly PathSpec[],
): Promise<Attachment[]> {
  if (paths.length === 0) return []
  if (vfs === undefined) {
    throw new Error('--attach needs a workspace to read files from')
  }
  const attachments: Attachment[] = []
  for (const path of paths) {
    let data: unknown
    try {
      data = await vfs.read(path)
    } catch (err) {
      if (isMissingPath(err) || isEnotdir(err)) {
        const strerror = fsStrerror(err) ?? posixPhrase('ENOENT')
        throw new Error(`read attachment ${path.virtual}: ${strerror}`)
      }
      throw err
    }
    const trimmed = rstripSlash(path.virtual)
    const filename = trimmed.slice(trimmed.lastIndexOf('/') + 1) || 'attachment'
    attachments.push({
      filename,
      contentType: mimeTypeFor(filename),
      data: data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike),
    })
  }
  return attachments
}

/**
 * Assembles a message, then sends it or writes its MIME to stdout.
 *
 * Shared by compose, reply and forward: the three differ only in the
 * source message they derive headers from. Without --send the raw RFC
 * 5322 bytes go to stdout, so a composer chain can pick them up.
 */
export async function route(
  accessor: EmailAccessor,
  fl: FlagView,
  stdin: ByteSource | null,
  source: Source | null,
  vfs: Files | undefined,
): Promise<CommandFnResult> {
  const raw = build(
    {
      sender: fl.asStr('from', accessor.config.username),
      to: splitAddresses(fl.asList('to')),
      cc: splitAddresses(fl.asList('cc')),
      bcc: splitAddresses(fl.asList('bcc')),
      subject: fl.asStr('subject') ?? null,
      body: await readBody(fl, stdin),
      signature: fl.asStr('signature') ?? null,
      attachments: await loadAttachments(vfs, fl.asPaths('attach')),
    },
    source,
  )
  const save = fl.asStr('save') ?? null
  if (!fl.asBool('send')) {
    if (save === null) return [raw as ByteSource, new IOResult()]
    // --save without --send files the message and sends nothing, so a
    // refused APPEND means nothing happened at all and may fail loudly:
    // there is no delivered message a retry could duplicate.
    const folder = await saveSentCopy(accessor, raw, save)
    const filed = await parseRfc822(raw)
    const saved = {
      status: 'saved',
      mailbox: folder,
      to: addressList(filed.to),
      subject: filed.subject,
    }
    return [compactJsonBytes(saved), new IOResult()]
  }
  const { parsed, warning } = await deliver(accessor, raw, save)
  const result = {
    status: 'sent',
    to: addressList(parsed.to),
    subject: parsed.subject,
  }
  return [
    compactJsonBytes(result),
    new IOResult({ stderr: warning === '' ? null : ENC.encode(warning) }),
  ]
}
