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
  mimeTypeFor,
  IOResult,
  PathSpec,
  isMissingPath,
  type ByteSource,
  type CLIVerbOpts,
  type CommandFnResult,
  type FlagView,
} from '@struktoai/mirage-core'
import type { EmailConfig } from '../../../../core/email/config.ts'
import { build, readBody, splitAddresses, type Attachment, type Source } from './builder.ts'
import { sendRaw } from './smtp.ts'

const ENC = new TextEncoder()

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
 * hands every CLI, the same door git reads repositories through. The
 * flag bag carries path values as their resolved virtual-path strings
 * (the python executor upgrades them to PathSpec instead).
 */
async function loadAttachments(
  ops: CLIVerbOpts | undefined,
  paths: readonly string[],
): Promise<Attachment[]> {
  if (paths.length === 0) return []
  const dispatch = ops?.dispatch
  if (dispatch === undefined) {
    throw new Error('--attach needs a workspace to read files from')
  }
  const attachments: Attachment[] = []
  for (const path of paths) {
    let data: unknown
    try {
      ;[data] = await dispatch('read', PathSpec.fromStrPath(path))
    } catch (err) {
      if (isMissingPath(err)) {
        throw new Error(`read attachment ${path}: No such file or directory`)
      }
      throw err
    }
    const trimmed = path.replace(/\/+$/, '')
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
  config: EmailConfig,
  fl: FlagView,
  stdin: ByteSource | null,
  source: Source | null,
  ops: CLIVerbOpts | undefined,
): Promise<CommandFnResult> {
  const raw = build(
    {
      sender: fl.asStr('from') ?? config.username,
      to: splitAddresses(fl.asList('to')),
      cc: splitAddresses(fl.asList('cc')),
      bcc: splitAddresses(fl.asList('bcc')),
      subject: fl.asStr('subject') ?? null,
      body: await readBody(fl, stdin),
      signature: fl.asStr('signature') ?? null,
      attachments: await loadAttachments(ops, fl.asList('attach')),
    },
    source,
  )
  if (!fl.asBool('send')) return [raw as ByteSource, new IOResult()]
  const parsed = await sendRaw(config, raw)
  const result = {
    status: 'sent',
    to: parsed.to
      .map((entry) => (entry.name === '' ? entry.email : `${entry.name} <${entry.email}>`))
      .join(', '),
    subject: parsed.subject,
  }
  return [ENC.encode(JSON.stringify(result)) as ByteSource, new IOResult()]
}
