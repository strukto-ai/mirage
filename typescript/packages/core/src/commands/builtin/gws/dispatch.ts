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
import { GDOCS_GWS_WRITE } from '../gdocs/gws_docs_write.ts'
import { GSHEETS_GWS_APPEND } from '../gsheets/gws_sheets_append.ts'
import { GSHEETS_GWS_READ } from '../gsheets/gws_sheets_read.ts'
import { GSHEETS_GWS_WRITE } from '../gsheets/gws_sheets_write.ts'
import { runGwsMethod } from './factory.ts'
import { GWS_METHODS, gwsCommandName, type GwsMethod } from './methods.ts'

const ENC = new TextEncoder()

// `gws` mirrors the official CLI: `gws <service> <resource> <method>` and
// `gws <service> +<helper>`. The mirage parser does the flag parsing from this
// spec; the body reconstructs the target command name from the operands and
// looks it up in the method table (or the helper map). No per-method routing.
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

const METHOD_BY_NAME = new Map<string, GwsMethod>(GWS_METHODS.map((m) => [gwsCommandName(m), m]))

function helperFn(commands: readonly RegisteredCommand[]): CommandFn {
  const [registered] = commands
  if (registered === undefined) throw new Error('gws: missing helper command')
  return registered.fn
}

const HELPERS = new Map<string, CommandFn>([
  ['gws-docs-write', helperFn(GDOCS_GWS_WRITE)],
  ['gws-sheets-read', helperFn(GSHEETS_GWS_READ)],
  ['gws-sheets-write', helperFn(GSHEETS_GWS_WRITE)],
  ['gws-sheets-append', helperFn(GSHEETS_GWS_APPEND)],
])

// The official CLI accepts --spreadsheet-id/--document-id; the helper commands
// take the short form.
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
    const helper = HELPERS.get(`gws-${service}-${second.slice(1)}`)
    if (helper === undefined) return usageError(`gws: unknown command ${service} ${second}`)
    return helper(accessor as never, [], [], { ...opts, flags: normalizeFlags(opts.flags) })
  }
  const method = words[2]
  if (method === undefined) return usageError(`gws: missing method for ${service} ${second}`)
  const gwsMethod = METHOD_BY_NAME.get(`gws-${service}-${second}-${method}`)
  if (gwsMethod === undefined) {
    return usageError(`gws: unknown method ${service} ${second} ${method}`)
  }
  return runGwsMethod(gwsMethod, accessor, paths, [], opts)
}

export const GWS_DISPATCH: readonly RegisteredCommand[] = command({
  name: 'gws',
  resource: [ResourceName.GDOCS, ResourceName.GSHEETS, ResourceName.GSLIDES, ResourceName.GDRIVE],
  spec: GWS_SPEC,
  write: true,
  fn: (accessor, paths, texts, opts) =>
    gwsDispatch(accessor as GoogleApiAccessor, paths, texts, opts),
})
