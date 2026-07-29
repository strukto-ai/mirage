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

import { IOResult } from '../../../io/types.ts'
import { command, type RegisteredCommand } from '../../config.ts'
import { CommandSpec } from '../../spec/types.ts'
import type { GwsService } from './methods.ts'
import {
  BESPOKE_COMMANDS,
  GWS_METHODS,
  SERVICE_RESOURCES,
  gwsCommandName,
  gwsMethodDescription,
} from './methods.ts'

const ENC = new TextEncoder()

const SERVICE_ORDER: readonly GwsService[] = ['drive', 'sheets', 'docs', 'slides', 'gmail'] as const

export function serviceNames(): GwsService[] {
  const present = new Set(GWS_METHODS.map((m) => m.service))
  return SERVICE_ORDER.filter((s) => present.has(s))
}

// Mirrors `gws <service> --help` in the official CLI, which lists the
// generated API methods and the hand-written helpers together.
export function renderServiceMethods(service: GwsService): string {
  const methods = GWS_METHODS.filter((m) => m.service === service)
  const helpers = BESPOKE_COMMANDS.filter(([n]) => n.startsWith(`gws ${service} `))
  const names = [...methods.map(gwsCommandName), ...helpers.map(([n]) => n)]
  const width = names.length > 0 ? Math.max(...names.map((n) => n.length)) : 0
  const lines = ['Methods:']
  for (const m of methods) {
    lines.push(`  ${gwsCommandName(m).padEnd(width, ' ')}  ${gwsMethodDescription(m)}`)
  }
  if (helpers.length > 0) {
    lines.push('')
    lines.push('Helpers:')
    for (const [name, desc] of helpers) {
      lines.push(`  ${name.padEnd(width, ' ')}  ${desc}`)
    }
  }
  lines.push('')
  lines.push("Run '<command> --help' for one command's flags.")
  return lines.join('\n')
}

export function renderServices(): string {
  const names = serviceNames()
  const width = names.length > 0 ? Math.max(...names.map((n) => n.length)) : 0
  const lines = ['Services:']
  for (const name of names) {
    const count = GWS_METHODS.filter((m) => m.service === name).length
    lines.push(`  ${name.padEnd(width, ' ')}  ${String(count)} API methods`)
  }
  lines.push('')
  lines.push("Run 'gws <service> --help' to list a service's commands.")
  return lines.join('\n')
}

const ROOT_DESCRIPTION = 'Google Workspace API commands'

export const ROOT_SPEC = new CommandSpec({
  description: ROOT_DESCRIPTION,
  epilog: renderServices(),
})

function helpCommand(
  name: string,
  description: string,
  body: string,
  resource: string,
): RegisteredCommand[] {
  return command({
    name,
    resource: [resource],
    spec: new CommandSpec({ description, epilog: body }),
    fn: () => Promise.resolve([ENC.encode(body + '\n'), new IOResult()]),
  })
}

// Each command is registered against the single resource asked for, so a
// mount only ever answers for the services it can actually reach: a
// gdocs-only mount must not serve `gws gmail`.
export function gwsHelpCommands(resource: string): RegisteredCommand[] {
  const out = [...helpCommand('gws', ROOT_DESCRIPTION, renderServices(), resource)]
  for (const service of serviceNames()) {
    if (!SERVICE_RESOURCES[service].includes(resource)) continue
    out.push(
      ...helpCommand(
        `gws ${service}`,
        `Google ${service} API commands`,
        renderServiceMethods(service),
        resource,
      ),
    )
  }
  return out
}
