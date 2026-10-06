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

import { Buffer } from 'node:buffer'
import { buffer } from 'node:stream/consumers'
import type { Command } from 'commander'
import {
  BYTES,
  FLAG,
  INTEGER,
  OWNER,
  SIZE,
  VFS_CALLS,
  type VfsCall,
} from '@struktoai/mirage-server/vfs_calls'
import { makeClient } from './client.ts'
import { emit, handleResponse } from './output.ts'
import { loadDaemonSettings } from './settings.ts'

interface Target {
  workspace: string
  session?: string
  explain?: boolean
}

type Answer = Record<string, unknown>

/** Send one session call to the daemon. Mirrors Python's `post`. */
export async function post(
  target: Target,
  route: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const c = makeClient(loadDaemonSettings())
  await c.ensureRunning({ allowSpawn: false })
  const query = new URLSearchParams()
  if (target.session !== undefined) query.set('session_id', target.session)
  if (target.explain === true) query.set('explain', 'true')
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  const path = `/v1/workspaces/${encodeURIComponent(target.workspace)}/${route}${suffix}`
  return c.request('POST', path, { body: JSON.stringify(body) })
}

/**
 * A call's answer, or its failure in the call's own words: a refused or
 * failed call prints its errno and exits 1, with the policy's reason on a
 * line of its own. Mirrors Python's `answer`.
 */
export async function answer(r: Response): Promise<unknown> {
  if (r.status >= 400) {
    const text = await r.clone().text()
    let body: { detail?: string; errno?: string; refusal?: { reason: string } | null } = {}
    try {
      body = JSON.parse(text) as typeof body
    } catch {
      // not JSON: the generic handler reports the raw text
    }
    if (body.errno !== undefined) {
      process.stderr.write(`${String(body.detail)} (${body.errno})\n`)
      if (body.refusal) process.stderr.write(`policy denied: ${body.refusal.reason}\n`)
      process.exit(1)
    }
  }
  return handleResponse(r)
}

function explained(said: Answer): string {
  let verdict = String(said.outcome)
  if (said.reason !== '') verdict += `: ${String(said.reason)}`
  let line = `${String(said.call)} ${(said.paths as string[]).join(' ')}  [${verdict}]`
  if (said.error !== '') line += `  ${String(said.error)}`
  return line
}

const text =
  (key: string) =>
  (result: Answer): string =>
    Buffer.from(String(result[key]), 'base64').toString('utf-8')

const HUMAN: Readonly<Record<string, (result: Answer) => string>> = {
  read: text('data_base64'),
  getxattr: text('value_base64'),
  cat: (result) => String(result.text),
  readdir: (result) => (result.entries as string[]).join('\n'),
  list_files: (result) => (result.files as string[]).join('\n'),
  listxattr: (result) => (result.names as string[]).join('\n'),
  readlink: (result) => String(result.target),
}

const flagName = (name: string): string => name.replace(/_base64$/, '')

async function value(call: VfsCall, name: string, given: unknown): Promise<unknown> {
  if (call.params[name] === BYTES) {
    const data = typeof given === 'string' ? Buffer.from(given) : await buffer(process.stdin)
    return data.toString('base64')
  }
  if (call.params[name] === OWNER && typeof given === 'string' && /^\d+$/.test(given))
    return Number(given)
  return given
}

function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * The `mirage vfs <call>` command for one call: the call's required
 * arguments in order, then an option for each of the rest. Mirrors
 * Python's `command`.
 */
function command(vfs: Command, call: VfsCall): void {
  const cmd = vfs.command(call.name.replace(/_/g, '-')).description(call.description)
  const positional = Object.keys(call.params).filter(
    (name) => call.required.includes(name) && call.params[name] !== BYTES,
  )
  for (const name of positional) cmd.argument(`<${name}>`)
  for (const name of Object.keys(call.params)) {
    if (positional.includes(name)) continue
    if (call.params[name] === BYTES) {
      const flag = flagName(name)
      cmd.option(`--${flag} <text>`, `The ${flag} as text; stdin when absent`)
    } else if (call.params[name] === FLAG) {
      cmd.option(`--${name}`)
    } else if (call.params[name] === INTEGER || call.params[name] === SIZE) {
      cmd.option(`--${name} <n>`, `The ${name}`, Number)
    } else {
      cmd.option(`--${name} <value>`)
    }
  }
  cmd
    .requiredOption('-w, --workspace <id>', 'Workspace id')
    .option('-s, --session <id>', 'Session id')
    .option('--explain', 'Say what the call would do; run nothing')
    .action(async (...given: unknown[]) => {
      const opts = given[positional.length] as Target & Record<string, unknown>
      const body: Record<string, unknown> = {}
      for (const [i, name] of positional.entries()) {
        body[name] = call.params[name] === INTEGER ? Number(given[i]) : given[i]
      }
      for (const name of Object.keys(call.params)) {
        if (positional.includes(name)) continue
        const raw = opts[camel(call.params[name] === BYTES ? flagName(name) : name)]
        if (call.params[name] === BYTES || raw !== undefined)
          body[name] = await value(call, name, raw)
      }
      const result = (await answer(await post(opts, `vfs/${call.name}`, body))) as Answer
      emit(result, opts.explain === true ? explained : HUMAN[call.name])
    })
}

/** `mirage vfs <call>` for each `session.vfs` call, and `mirage glob`. */
export function registerVfsCommands(program: Command): void {
  const vfs = program
    .command('vfs')
    .description("The session's VFS calls, one command per call, as POSIX names them.")
  for (const call of VFS_CALLS) command(vfs, call)
  program
    .command('glob')
    .description('Every path a pattern matches, as the session sees them.')
    .argument('<pattern>', 'Pathname pattern such as /**/*.py')
    .requiredOption('-w, --workspace <id>', 'Workspace id')
    .option('-s, --session <id>', 'Session id')
    .action(async (pattern: string, opts: Target) => {
      const result = (await answer(await post(opts, 'glob', { pattern }))) as {
        paths: string[]
      }
      emit(result, (r) => r.paths.join('\n'))
    })
}
