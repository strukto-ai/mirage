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
import type { Command } from 'commander'
import { makeClient } from './client.ts'
import { emit, fail, formatTable, handleResponse } from './output.ts'

interface PolicyBody {
  name: string
  source: string
}

interface PolicyName {
  name: string
}

type Format = 'yaml' | 'json'

const FORMATS: readonly string[] = ['yaml', 'json']

/** The program `--source` names: `@FILE` reads a file, anything else is the program itself. */
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

function formatOf(output: string | undefined): Format | undefined {
  if (output === undefined) return undefined
  if (!FORMATS.includes(output)) fail(`--output must be yaml or json, got ${output}`, 2)
  return output as Format
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

async function render(
  obj: unknown,
  format: Format | undefined,
  human: () => string,
): Promise<void> {
  if (format === 'json') {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
    return
  }
  if (format === 'yaml') {
    const { stringify } = await import('yaml')
    process.stdout.write(stringify(obj))
    return
  }
  emit(obj, human)
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
    .option('-o, --output <format>', 'yaml or json')
    .action(async (opts: { output?: string }) => {
      const format = formatOf(opts.output)
      const items = itemsOf(await call('GET', ''))
      await render(items, format, () =>
        formatTable(
          ['NAME'],
          items.map((p) => [p.name]),
        ),
      )
    })

  policy
    .command('get')
    .description('Show one policy; in a terminal, its source.')
    .argument('<name>', "The policy's name, such as guard.py.")
    .option('-o, --output <format>', 'yaml or json')
    .action(async (name: string, opts: { output?: string }) => {
      const format = formatOf(opts.output)
      const got = (await call('GET', ref(name))) as PolicyBody
      await render(got, format, () => got.source.replace(/\n+$/, ''))
    })

  policy
    .command('update')
    .description("Replace a saved policy's source.")
    .argument('<name>', "The policy's name, such as guard.py.")
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
    .argument('<name>', "The policy's name, such as guard.py.")
    .action(async (name: string) => {
      await call('DELETE', ref(name))
      process.stdout.write(`Deleted policy ${name}.\n`)
    })
}
