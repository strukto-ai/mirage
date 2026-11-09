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
import { FlagView } from '../../../spec/index.ts'
import { MailboxNotFound } from '../../../../core/email/client.ts'
import { compactJsonBytes } from '../../../../core/render/json.ts'
import { IOResult } from '../../../../io/types.ts'
import type { EmailAccessor } from '../../../../accessor/email.ts'

const SUGGESTION = 'Run with --log-level to enable more verbose logs'
const ENC = new TextEncoder()

type LeafFn = (
  accessor: EmailAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
) => Promise<CommandFnResult>

/** A failure that names what caused it, as `Caused by:` lines. */
export class ChainedError extends Error {
  constructor(
    message: string,
    readonly sources: readonly string[] = [],
  ) {
    super(message)
  }
}

/** A command's output in the mode the line asked for. */
export function rendered(fl: FlagView, document: unknown, text: string): Uint8Array {
  return fl.asBool('json') ? compactJsonBytes(document) : ENC.encode(text)
}

/** A one-line confirmation. */
export function notice(fl: FlagView, text: string): Uint8Array {
  return rendered(fl, { message: text }, `${text}\n`)
}

/** A failure as the upstream program prints it, to standard output. */
export function errorReport(error: unknown, asJson: boolean): Uint8Array {
  const message =
    error instanceof MailboxNotFound
      ? `IMAP ${error.verb} failed: ${error.detail}`
      : error instanceof Error
        ? error.message
        : String(error)
  const sources = error instanceof ChainedError ? [...error.sources] : []
  if (asJson) return compactJsonBytes({ error: message, sources, backtrace: null })
  let text = `Error: ${message}`
  if (sources.length > 0) {
    text += `\n\nCaused by:\n${sources.map((source) => ` - ${source.trim()}`).join('\n')}`
  }
  return ENC.encode(`${text}\n\nSuggestions:\n - ${SUGGESTION}\n`)
}

/** Report a leaf's failure the way the upstream program does. */
export function guarded(fn: LeafFn): LeafFn {
  return async (accessor, paths, texts, ctx) => {
    try {
      return await fn(accessor, paths, texts, ctx)
    } catch (error) {
      const asJson = new FlagView(ctx.flags, ctx.spec).asBool('json')
      return [errorReport(error, asJson), new IOResult({ exitCode: 1 })]
    }
  }
}
