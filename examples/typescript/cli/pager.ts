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
  CLISpec,
  type CLIInvocation,
  IOResult,
  Operand,
  Option,
  RAMResource,
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
  // registerCli validates this schema once per installation. CLISpec is not
  // generic, so narrow the already-validated value at the handler boundary.
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
  const lines = Object.entries(accountIncidents(account))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([incidentId, incident]) => {
      const state =
        incident.acknowledgedBy === undefined
          ? 'open'
          : `acknowledged-by=${incident.acknowledgedBy}`
      return `[${account}] ${incidentId} ${state} ${incident.summary}`
    })
  return Promise.resolve([enc.encode(`${lines.join('\n')}\n`), new IOResult()])
}

function acknowledge(inv: CLIInvocation): CommandFnResult {
  const { account } = configOf(inv)
  const incidentId = inv.texts[0]
  const by = inv.flags.by
  // Operand.required is enforced by the executor only under the CLAP
  // dialect; an argparse-style leaf words its own missing-operand refusal.
  if (incidentId === undefined) throw new Error('INCIDENT_ID is required')
  if (typeof by !== 'string') throw new Error('--by must be a string')
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

export const PAGER = new CLISpec({
  name: 'pager',
  description: 'Task-specific incident CLI',
  configModel: PagerConfigSchema,
  subcommands: [
    new CLISpec({
      name: 'list',
      description: 'List incidents for this installed account',
      fn: listIncidents,
    }),
    new CLISpec({
      name: 'ack',
      description: 'Acknowledge an incident',
      fn: acknowledge,
      // write labels the leaf for policy; the handler still owns the
      // service mutation and its cache/invalidation semantics.
      write: true,
      positional: [new Operand({ name: 'INCIDENT_ID', type: 'str', required: true })],
      options: [
        new Option({
          long: '--by',
          type: 'str',
          required: true,
          description: 'Person acknowledging the incident',
        }),
      ],
    }),
  ],
})

async function show(ws: Workspace, line: string): Promise<void> {
  console.log(`$ ${line}`)
  const result = await ws.execute(line)
  if (result.stdoutText !== '') process.stdout.write(result.stdoutText)
  if (result.stderrText !== '') process.stdout.write(result.stderrText)
  console.log()
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/workspace': new RAMResource() })

  // One immutable program tree can be installed more than once. Each head
  // word gets independently validated configuration: two accounts, one CLI.
  ws.registerCli('pager-eng', PAGER, { account: 'engineering' })
  ws.registerCli('pager-support', PAGER, { account: 'support' })

  try {
    await show(ws, 'type -t pager-eng')
    await show(ws, 'pager-eng --help')
    await show(ws, 'pager-eng list')
    await show(ws, 'pager-support list')
    await show(ws, 'pager-eng ack --by Mina')
    await show(ws, 'pager-eng ack __proto__ --by Mina')
    await show(ws, 'pager-eng ack INC-101 --by Mina')
    await show(ws, 'pager-eng list')
    await show(ws, 'pager-support list')
  } finally {
    await ws.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) await main()
