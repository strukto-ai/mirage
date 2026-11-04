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
import { buffer } from 'node:stream/consumers'
import type { Command } from 'commander'
import { makeClient } from './client.ts'
import { emit, fail, handleResponse } from './output.ts'

interface ApiOptions {
  method?: string
  input?: string
}

/** A file's text, or stdin's for `-`. */
async function text(path: string): Promise<string> {
  if (path === '-') return (await buffer(process.stdin)).toString('utf-8')
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    fail(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`, 2)
  }
}

/**
 * A field's value: JSON when it starts with `{` or `[`, the file's text
 * for `@file` (`@-` stdin), else the string. Mirrors Python's
 * `field_value`.
 */
async function fieldValue(key: string, raw: string): Promise<unknown> {
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as unknown
    } catch (err) {
      fail(`--${key} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, 2)
    }
  }
  if (raw.startsWith('@')) return text(raw.slice(1))
  return raw
}

/**
 * The fields in the words after the route: `--key value`,
 * `--key=value`, or a bare `--flag`, which is `true`. Mirrors Python's
 * `parse_fields`.
 */
async function parseFields(words: string[]): Promise<[string, unknown][]> {
  const fields: [string, unknown][] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    const eq = word.indexOf('=')
    const key = word.slice(2, eq === -1 ? undefined : eq)
    if (!word.startsWith('--') || key === '') fail(`${word}: a field is --key value`, 2)
    if (eq !== -1) {
      fields.push([key, await fieldValue(key, word.slice(eq + 1))])
      continue
    }
    const next = words[i + 1]
    if (next === undefined || next.startsWith('--')) {
      fields.push([key, true])
      continue
    }
    fields.push([key, await fieldValue(key, next)])
    i++
  }
  return fields
}

/**
 * Call any route of the server the CLI points at, as `gh api` does:
 * with the CLI's own login or token, so nothing else needs one. Every
 * other `--key value` is a field: fields make a JSON body, or the query
 * string of a GET; `--input` sends a YAML or JSON file as the body.
 * Prints the answer: JSON as JSON, nothing for a 204. Mirrors Python's
 * `api_cmd`.
 */
export function registerApiCommand(program: Command): void {
  program
    .command('api')
    .argument('<path>', 'The route, such as /v1/workspaces')
    .description("Call a route of the server, with the CLI's login.")
    .usage('<path> [--key value ...]')
    .option('-X, --method <method>', 'The HTTP method: GET, or POST with fields or --input')
    .option('--input <file>', 'The body, from a YAML or JSON file; - reads stdin')
    .addHelpText(
      'after',
      [
        '',
        'Every other option is a field: --key value or --key=value. A value',
        'starting with { or [ is JSON, @file reads the file (@- stdin), and a',
        'bare --flag is true. Fields make a JSON body, or the query string of',
        'a GET; --input sends a YAML or JSON file as the body instead.',
      ].join('\n'),
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (route: string, opts: ApiOptions, cmd: Command) => {
      if (route.includes('://') || route.startsWith('-')) {
        fail('api takes a route of the server first, such as /v1/workspaces', 2)
      }
      const fields = await parseFields(cmd.args.slice(1))
      if (opts.input !== undefined && fields.length > 0) {
        fail('give fields or --input, not both', 2)
      }
      const hasBody = opts.input !== undefined || fields.length > 0
      const method = (opts.method ?? (hasBody ? 'POST' : 'GET')).toUpperCase()
      const bodyless = method === 'GET' || method === 'HEAD'
      if (bodyless && opts.input !== undefined) fail(`${method} takes no body; give -X`, 2)
      let body: unknown
      if (opts.input !== undefined) {
        const { parse } = await import('yaml')
        try {
          body = parse(await text(opts.input)) as unknown
        } catch (err) {
          fail(`invalid YAML/JSON in ${opts.input}: ${String(err)}`, 2)
        }
      } else if (fields.length > 0) {
        body = Object.fromEntries(fields)
      }
      let path = route.startsWith('/') ? route : `/${route}`
      if (bodyless) {
        // As gh does: a GET's fields are its query string.
        if (fields.length > 0) {
          const query = new URLSearchParams(
            fields.map(([key, value]): [string, string] => [
              key,
              typeof value === 'string' ? value : JSON.stringify(value),
            ]),
          )
          path += `${path.includes('?') ? '&' : '?'}${query.toString()}`
        }
        body = undefined
      }
      const c = makeClient()
      await c.ensureRunning({ allowSpawn: false })
      const r = await c.request(
        method,
        path,
        body === undefined ? {} : { body: JSON.stringify(body) },
      )
      if (r.status >= 400) await handleResponse(r)
      const answer = await r.text()
      if (answer === '') return
      if (r.headers.get('content-type')?.includes('json') === true) emit(JSON.parse(answer))
      else process.stdout.write(answer)
    })
}
