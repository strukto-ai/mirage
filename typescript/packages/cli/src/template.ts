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
import { dirname, resolve } from 'node:path'
import type { Command } from 'commander'
import { makeClient } from './client.ts'
import { header } from './settings.ts'
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

interface Template {
  name: string
  description: string | null
  config: Record<string, unknown>
}

async function asYaml(obj: unknown): Promise<string> {
  const { dumpYaml } = await import('@struktoai/mirage-node/utils/yaml')
  return dumpYaml(obj)
}

/**
 * A template file: a mapping with `config`, as either server's `get` prints
 * it, or a bare workspace config. Only `description` and `config` are read;
 * the fields a server fills in are dropped. Saved as written, with no `${NAME}` read from the
 * environment; a relative `script` or code path is rebased onto the file's
 * folder, as `workspace create` does.
 */
async function readTemplate(
  path: string,
): Promise<{ description: string | null; config: unknown }> {
  const { parse } = await import('yaml')
  const { absolutizeScripts } = await import('@struktoai/mirage-node/config')
  let doc: unknown
  try {
    doc = parse(readFileSync(path, 'utf-8')) as unknown
  } catch (err) {
    fail(`cannot read ${path}: ${(err as Error).message}`, 2)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail(`${path} must hold a mapping`, 2)
  }
  const found = doc as Record<string, unknown>
  let description: unknown = null
  let config: unknown = found
  if ('config' in found) {
    description = found.description ?? null
    config = found.config
  }
  if (description !== null && typeof description !== 'string') {
    fail(`${path}: description must be a string`, 2)
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    fail(`${path}: config must hold a mapping`, 2)
  }
  absolutizeScripts(config as Record<string, unknown>, dirname(resolve(path)))
  return { description, config }
}

function templatePath(name: string): string {
  return `/v1/templates/${encodeURIComponent(name)}`
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const c = makeClient()
  await c.ensureRunning({ allowSpawn: true })
  return handleResponse(
    await c.request(method, path, body === undefined ? {} : { body: JSON.stringify(body) }),
  )
}

/** `mirage template`: saved workspace configs over `/v1/templates`. */
export function registerTemplateCommands(program: Command): void {
  const template = program
    .command('template')
    .description('Saved workspace configs: create, list, get, delete, restore.')

  template
    .command('create')
    .description('Save a workspace config as a template.')
    .argument('<name>', 'Template name')
    .requiredOption(
      '-f, --file <file>',
      'A workspace config, or a template as `get -o yaml` prints it',
    )
    .option('--description <text>', 'Say what the template is for')
    .action(async (name: string, opts: { file: string; description?: string }) => {
      const found = await readTemplate(opts.file)
      const created = (await call('POST', '/v1/templates', {
        name,
        description: opts.description ?? found.description,
        config: found.config,
      })) as Template
      header(`created template ${name}`)
      const text = await asYaml(created)
      emit(created, () => text.trimEnd())
    })

  template
    .command('list')
    .description('List the saved templates.')
    .action(async () => {
      const { items } = (await call('GET', '/v1/templates')) as { items: Template[] }
      emit(items, (rows) =>
        formatTable(
          ['NAME', 'DESCRIPTION'],
          rows.map((t) => [t.name, t.description ?? '']),
        ),
      )
    })

  template
    .command('get')
    .description('Print a template; `-o yaml` is a file `create -f` reads.')
    .argument('<id>', ID_HELP)
    .option('-o, --output <format>', 'yaml: a file create -f and update -f read.', outputOf)
    .action(async (name: string, opts: { output?: Output }) => {
      const found = (await call('GET', templatePath(name))) as Template
      const text = await asYaml(found)
      await show(found, opts.output, () => text.trimEnd())
    })

  template
    .command('delete')
    .description('Delete a template; `restore` brings it back.')
    .argument('<id>', ID_HELP)
    .action(async (name: string) => {
      await call('DELETE', templatePath(name))
      header(`deleted template ${name}`)
      emit({ deleted: name }, () => `Deleted template ${name}.`)
    })

  template
    .command('restore')
    .description('Bring back a deleted template.')
    .argument('<id>', ID_HELP)
    .action(async (name: string) => {
      const restored = (await call('POST', `${templatePath(name)}/restore`)) as Template
      header(`restored template ${name}`)
      const text = await asYaml(restored)
      emit(restored, () => text.trimEnd())
    })
}
