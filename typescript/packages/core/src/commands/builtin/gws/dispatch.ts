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

import type { GoogleApiAccessor } from '../../../accessor/google_api.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import {
  command,
  type CommandFn,
  type CommandFnResult,
  type CommandOpts,
  type RegisteredCommand,
} from '../../config.ts'
import { CommandSpec, Operand, OperandKind, Option } from '../../spec/types.ts'
import { GDOCS_GWS_BATCH_UPDATE } from '../gdocs/gws_docs_documents_batchUpdate.ts'
import { GDOCS_GWS_CREATE } from '../gdocs/gws_docs_documents_create.ts'
import { GDOCS_GWS_WRITE } from '../gdocs/gws_docs_write.ts'
import { GSHEETS_GWS_APPEND } from '../gsheets/gws_sheets_append.ts'
import { GSHEETS_GWS_READ } from '../gsheets/gws_sheets_read.ts'
import { GSHEETS_GWS_BATCH_UPDATE } from '../gsheets/gws_sheets_spreadsheets_batchUpdate.ts'
import { GSHEETS_GWS_CREATE } from '../gsheets/gws_sheets_spreadsheets_create.ts'
import { GSHEETS_GWS_WRITE } from '../gsheets/gws_sheets_write.ts'
import { GSLIDES_GWS_BATCH_UPDATE } from '../gslides/gws_slides_presentations_batchUpdate.ts'
import { GSLIDES_GWS_CREATE } from '../gslides/gws_slides_presentations_create.ts'
import { invalidateMountListing, runGwsMethod } from './factory.ts'
import { GWS_METHODS, type GwsMethod } from './methods.ts'

const ENC = new TextEncoder()

// The top-level `gws` command accepts the official CLI syntax
// (`gws docs documents get --params '...'`) and routes to the per-method
// mirage commands, so agent playbooks written against the official CLI run
// verbatim on a mounted Google resource. `+` convenience commands map to
// the bespoke helpers; Discovery methods map to the passthrough factory.
const GWS_SPEC = new CommandSpec({
  options: [
    new Option({ long: '--params', valueKind: OperandKind.TEXT }),
    new Option({ long: '--json', valueKind: OperandKind.TEXT }),
    new Option({ long: '--spreadsheet', valueKind: OperandKind.TEXT }),
    new Option({ long: '--spreadsheet-id', valueKind: OperandKind.TEXT }),
    new Option({ long: '--range', valueKind: OperandKind.TEXT }),
    new Option({ long: '--values', valueKind: OperandKind.TEXT }),
    new Option({ long: '--json-values', valueKind: OperandKind.TEXT }),
    new Option({ long: '--document', valueKind: OperandKind.TEXT }),
    new Option({ long: '--document-id', valueKind: OperandKind.TEXT }),
    new Option({ long: '--text', valueKind: OperandKind.TEXT }),
  ],
  rest: new Operand({ kind: OperandKind.TEXT }),
})

const API_METHODS = new Map<string, GwsMethod>(
  GWS_METHODS.map((m) => [`${m.service} ${m.resource} ${m.method}`, m]),
)

function fnOf(commands: readonly RegisteredCommand[]): CommandFn {
  const first = commands[0]
  if (first === undefined) throw new Error('empty command group')
  return first.fn
}

const BESPOKE = new Map<string, CommandFn>([
  ['docs documents create', fnOf(GDOCS_GWS_CREATE)],
  ['docs documents batchUpdate', fnOf(GDOCS_GWS_BATCH_UPDATE)],
  ['sheets spreadsheets create', fnOf(GSHEETS_GWS_CREATE)],
  ['sheets spreadsheets batchUpdate', fnOf(GSHEETS_GWS_BATCH_UPDATE)],
  ['slides presentations create', fnOf(GSLIDES_GWS_CREATE)],
  ['slides presentations batchUpdate', fnOf(GSLIDES_GWS_BATCH_UPDATE)],
])

const PLUS = new Map<string, CommandFn>([
  ['docs +write', fnOf(GDOCS_GWS_WRITE)],
  ['sheets +read', fnOf(GSHEETS_GWS_READ)],
  ['sheets +append', fnOf(GSHEETS_GWS_APPEND)],
  ['sheets +write', fnOf(GSHEETS_GWS_WRITE)],
])

// The official CLI accepts both --spreadsheet-id/--spreadsheet and
// --document-id/--document; the bespoke helpers take the short form.
const FLAG_ALIASES: Record<string, string> = {
  'spreadsheet-id': 'spreadsheet',
  'document-id': 'document',
}

type Flags = CommandOpts['flags']

export function normalizeFlags(flags: Flags): Flags {
  const out: Flags = {}
  for (const [key, value] of Object.entries(flags)) {
    out[FLAG_ALIASES[key] ?? key] = value
  }
  return out
}

function usageError(message: string): CommandFnResult {
  return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${message}\n`) })]
}

export async function gwsDispatch(
  accessor: GoogleApiAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const words = texts.filter((t) => t !== '')
  const service = words[0]
  const second = words[1]
  if (service === undefined || second === undefined) {
    return usageError(
      'Usage: gws <service> <resource> <method> [--params JSON] [--json JSON] | ' +
        'gws <service> +<helper> [flags]',
    )
  }
  if (second.startsWith('+')) {
    const plus = PLUS.get(`${service} ${second}`)
    if (plus === undefined) return usageError(`gws: unknown command ${service} ${second}`)
    const result = await plus(accessor as never, [], [], {
      ...opts,
      flags: normalizeFlags(opts.flags),
    })
    if (second !== '+read') await invalidateMountListing()
    return result
  }
  const method = words[2]
  if (method === undefined) return usageError(`gws: missing method for ${service} ${second}`)
  const key = `${service} ${second} ${method}`
  const api = API_METHODS.get(key)
  if (api !== undefined) return runGwsMethod(api, accessor, paths, [], opts)
  const bespoke = BESPOKE.get(key)
  if (bespoke !== undefined) {
    const result = await bespoke(accessor as never, [], [], opts)
    await invalidateMountListing()
    return result
  }
  return usageError(`gws: unknown method ${key}`)
}

export const GWS_DISPATCH: readonly RegisteredCommand[] = command({
  name: 'gws',
  resource: [ResourceName.GDOCS, ResourceName.GSHEETS, ResourceName.GSLIDES, ResourceName.GDRIVE],
  spec: GWS_SPEC,
  write: true,
  fn: (accessor, paths, texts, opts) =>
    gwsDispatch(accessor as GoogleApiAccessor, paths, texts, opts),
})
