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

import { pathToFileURL } from 'node:url'

import {
  CLI,
  CLIHandler,
  CommandSpec,
  FlagView,
  type CLIInvocation,
  IOResult,
  Argument,
  RAMVFS,
  Workspace,
  z,
  type CommandFnResult,
} from '@struktoai/mirage-node'

const PagerConfigSchema = z.object({ account: z.enum(['engineering', 'support']) })
type PagerConfig = z.infer<typeof PagerConfigSchema>

interface Incident {
  summary: string
  acknowledgedBy?: string
}

// A real CLI would construct its service client from inv.config. This
// deterministic service keeps the example runnable without credentials or
// network access while preserving the same per-account semantics.
const INCIDENTS: Record<PagerConfig['account'], Record<string, Incident>> = {
  engineering: {
    'INC-101': { summary: 'Database latency' },
  },
  support: {
    'INC-202': { summary: 'Checkout retries' },
  },
}

const enc = new TextEncoder()

function configOf(inv: CLIInvocation): PagerConfig {
  // registerCli validates the account before the handler runs.
  return inv.config as PagerConfig
}

function accountIncidents(account: PagerConfig['account']): Record<string, Incident> {
  return INCIDENTS[account]
}

// A leaf returns its result directly or as a promise, whichever its body
// needs: the executor awaits either, so a handler that reaches a service
// and one that answers from memory are written the same way, and one that
// throws before any await is refused exactly like one that rejects.
function listIncidents(inv: CLIInvocation): Promise<CommandFnResult> {
  const { account } = configOf(inv)
  const wanted = new Set(inv.texts)
  const status = new FlagView(inv.flags, inv.spec).asStr('state')
  const lines = Object.entries(accountIncidents(account))
    .filter(
      ([id, incident]) =>
        (wanted.size === 0 || wanted.has(id)) &&
        (!status || status === (incident.acknowledgedBy === undefined ? 'open' : 'acknowledged')),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([incidentId, incident]) => {
      const state =
        incident.acknowledgedBy === undefined
          ? 'open'
          : `acknowledged-by=${incident.acknowledgedBy}`
      return `[${account}] ${incidentId} ${state} ${incident.summary}`
    })
  return Promise.resolve([
    enc.encode(lines.length === 0 ? '' : `${lines.join('\n')}\n`),
    new IOResult(),
  ])
}

function acknowledge(inv: CLIInvocation): CommandFnResult {
  const { account } = configOf(inv)
  const incidentId = inv.texts[0]
  const by = new FlagView(inv.flags, inv.spec).asStr('by')
  if (incidentId === undefined) throw new Error('INCIDENT_ID is required')
  const incidents = accountIncidents(account)
  const incident = Object.hasOwn(incidents, incidentId) ? incidents[incidentId] : undefined
  if (incident === undefined) {
    return [
      null,
      new IOResult({ exitCode: 1, stderr: enc.encode(`pager: unknown incident ${incidentId}\n`) }),
    ]
  }
  incident.acknowledgedBy = by
  return [enc.encode(`[${account}] acknowledged ${incidentId} by ${by}\n`), new IOResult()]
}

export const PAGER = new CLI({
  spec: new CommandSpec({
    name: 'pager',
    description: 'Task-specific incident CLI',
    subcommands: [
      new CommandSpec({
        name: 'list',
        description: 'List incidents for this installed account',
        arguments: [
          new Argument('INCIDENT_ID', { nargs: '*' }),
          new Argument('--state', { choices: ['open', 'acknowledged'] }),
        ],
      }),
      new CommandSpec({
        name: 'ack',
        description: 'Acknowledge an incident',
        arguments: [
          new Argument('INCIDENT_ID', { help: 'Incident to acknowledge' }),
          new Argument('--by', { required: true, help: 'Person acknowledging the incident' }),
        ],
      }),
    ],
  }),
  handlers: {
    list: new CLIHandler({ fn: listIncidents }),
    ack: new CLIHandler({ fn: acknowledge, write: true }),
  },
  configModel: PagerConfigSchema,
})

async function show(ws: Workspace, line: string, expectedExit = 0): Promise<void> {
  console.log(`$ ${line}`)
  const result = await ws.shell(line)
  if (result.exitCode !== expectedExit) {
    throw new Error(
      `${line}: expected exit ${expectedExit}, got ${result.exitCode}: ${result.stderrText}`,
    )
  }
  if (result.stdoutText !== '') process.stdout.write(result.stdoutText)
  if (result.stderrText !== '') process.stdout.write(result.stderrText)
  console.log()
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/workspace': new RAMVFS() })

  // One immutable program tree can be installed more than once. Each head
  // word gets independently validated configuration: two accounts, one CLI.
  ws.registerCli('pager-eng', PAGER, { account: 'engineering' })
  ws.registerCli('pager-support', PAGER, { account: 'support' })

  try {
    await show(ws, 'type -t pager-eng')
    await show(ws, 'pager-eng --help')
    await show(ws, 'pager-eng ack --help')
    await show(ws, 'pager-eng list')
    await show(ws, 'pager-support list')
    await show(ws, 'pager-eng list INC-101 INC-404 --state open')
    await show(ws, 'pager-eng list --state invalid', 2)
    await show(ws, 'pager-eng ack --by Mina', 2)
    await show(ws, 'pager-eng ack __proto__ --by Mina', 1)
    await show(ws, 'pager-eng ack INC-101 --by Mina')
    await show(ws, 'pager-eng list --state acknowledged INC-101')
    await show(ws, 'pager-eng list INC-101 --state open')
    await show(ws, 'pager-eng list')
    await show(ws, 'pager-support list')
  } finally {
    await ws.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) await main()
