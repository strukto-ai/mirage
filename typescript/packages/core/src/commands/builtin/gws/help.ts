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
import { ResourceName } from '../../../types.ts'
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

export const ROOT_SPEC = new CommandSpec({
  description: 'Google Workspace API commands',
  epilog: renderServices(),
})

function makeServiceHelpCommand(service: GwsService): RegisteredCommand[] {
  const body = renderServiceMethods(service)
  return command({
    name: `gws ${service}`,
    resource: SERVICE_RESOURCES[service],
    spec: new CommandSpec({
      description: `Google ${service} API commands`,
      epilog: body,
    }),
    fn: () => Promise.resolve([ENC.encode(body + '\n'), new IOResult()]),
  })
}

export const GWS_ROOT_COMMANDS: readonly RegisteredCommand[] = command({
  name: 'gws',
  resource: [
    ResourceName.GDRIVE,
    ResourceName.GSHEETS,
    ResourceName.GDOCS,
    ResourceName.GSLIDES,
    ResourceName.GMAIL,
  ],
  spec: ROOT_SPEC,
  fn: () => Promise.resolve([ENC.encode(renderServices() + '\n'), new IOResult()]),
})

export const GWS_SERVICE_HELP_COMMANDS: readonly RegisteredCommand[] =
  serviceNames().flatMap(makeServiceHelpCommand)
