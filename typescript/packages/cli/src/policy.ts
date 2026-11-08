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
import { readFileSync } from 'node:fs'
import { POLICY_NAME } from '@struktoai/mirage-core/resources/constants'
import { isRecord } from '@struktoai/mirage-core/utils/records'
import type { Command } from 'commander'
import { makeClient } from './client.ts'
import {
  emit,
  fail,
  formatTable,
  handleResponse,
  ID_HELP,
  outputOf,
  show,
  type Output,
} from './output.ts'

interface PolicyBody {
  name: string
  source: string
}

interface PolicyName {
  name: string
}

/** The program `--source` names: `@FILE` reads a file, anything else is the program itself. */
/**
 * Run `rebase`, which turns a config's relative script paths into absolute
 * ones, keeping each profile program whose `script` names a saved policy,
 * such as `guard.py`, as written: the server reads that policy's source. A
 * path such as `./guard.py` is a file next to the config and is rebased.
 */
export function keepPolicyNames(config: Record<string, unknown>, rebase: () => void): void {
  const kept: [Record<string, unknown>, string][] = []
  const profiles = isRecord(config.profiles) ? Object.values(config.profiles) : []
  for (const profile of profiles) {
    if (!isRecord(profile) || !isRecord(profile.policy)) continue
    for (const programs of Object.values(profile.policy)) {
      for (const program of Array.isArray(programs) ? programs : []) {
        if (
          isRecord(program) &&
          typeof program.script === 'string' &&
          POLICY_NAME.test(program.script)
        ) {
          kept.push([program, program.script])
        }
      }
    }
  }
  rebase()
  for (const [program, script] of kept) program.script = script
}

export function readSource(given: string): string {
  if (!given.startsWith('@')) return given
  const path = given.slice(1)
  try {
    return readFileSync(path, 'utf-8')
  } catch (e) {
    return fail(`cannot read ${path}: ${(e as Error).message}`, 2)
  }
}

/** A list's policies, from `{items}` or a bare array. */
export function itemsOf(answer: unknown): PolicyName[] {
  if (Array.isArray(answer)) return answer as PolicyName[]
  const items = (answer as { items?: PolicyName[] } | null)?.items
  return items ?? []
}

/** One request to the daemon's `/v1/policies`, answered as JSON. */
async function call(method: string, path: string, body?: Record<string, string>): Promise<unknown> {
  const c = makeClient()
  await c.ensureRunning({ allowSpawn: false })
  const init = body === undefined ? {} : { body: JSON.stringify(body) }
  return handleResponse(await c.request(method, `/v1/policies${path}`, init))
}

function ref(name: string): string {
  return `/${encodeURIComponent(name)}`
}

export function registerPolicyCommands(program: Command): void {
  const policy = program
    .command('policy')
    .description('Manage saved policies: Python programs a workspace config names.')

  policy
    .command('create')
    .description('Save a new policy; a name already saved is refused.')
    .argument('<name>', "The policy's name, such as guard.py.")
    .requiredOption('--source <source>', 'The program: @FILE reads a file, else the text.')
    .action(async (name: string, opts: { source: string }) => {
      const saved = (await call('POST', '', {
        name,
        source: readSource(opts.source),
      })) as PolicyBody
      emit(saved, (p) => `Created policy ${p.name}.`)
    })

  policy
    .command('list')
    .description('List saved policies by name.')
    .action(async () => {
      const items = itemsOf(await call('GET', ''))
      emit(items, () =>
        formatTable(
          ['NAME'],
          items.map((p) => [p.name]),
        ),
      )
    })

  policy
    .command('get')
    .description('Show one policy; in a terminal, its source.')
    .argument('<id>', ID_HELP)
    .option('-o, --output <format>', 'yaml: a file create -f and update -f read.', outputOf)
    .action(async (name: string, opts: { output?: Output }) => {
      const got = (await call('GET', ref(name))) as PolicyBody
      await show(got, opts.output, () => got.source.replace(/\n+$/, ''))
    })

  policy
    .command('update')
    .description("Replace a saved policy's source.")
    .argument('<id>', ID_HELP)
    .requiredOption('--source <source>', 'The program: @FILE reads a file, else the text.')
    .action(async (name: string, opts: { source: string }) => {
      const saved = (await call('PUT', ref(name), {
        source: readSource(opts.source),
      })) as PolicyBody
      emit(saved, (p) => `Updated policy ${p.name}.`)
    })

  policy
    .command('delete')
    .description('Delete a saved policy.')
    .argument('<id>', ID_HELP)
    .action(async (name: string) => {
      await call('DELETE', ref(name))
      process.stdout.write(`Deleted policy ${name}.\n`)
    })
}
