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
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { pipeline } from 'node:stream/promises'
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
import { resolveWorkspace } from './settings.ts'
import { emit, errorOf, handleResponse } from './output.ts'

interface Target {
  /** The workspace; the current one when left out. */
  workspace?: string
  session?: string
  explain?: boolean
}

/** The `-w` option every live command takes. */
export const WORKSPACE_FLAGS = '-w, --workspace <id>'
export const WORKSPACE_HELP = 'Workspace id; the current workspace when left out'

type Answer = Record<string, unknown>

/** The path of one session call. Mirrors Python's `_route`. */
function route(target: Target, call: string): string {
  const workspace = resolveWorkspace(target.workspace)
  const query = new URLSearchParams()
  if (target.session !== undefined) query.set('session_id', target.session)
  if (target.explain === true) query.set('explain', 'true')
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return `/v1/workspaces/${encodeURIComponent(workspace)}/${call}${suffix}`
}

/** Send one session call to the daemon. Mirrors Python's `post`. */
export async function post(
  target: Target,
  call: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const path = route(target, call)
  const c = makeClient()
  await c.ensureRunning({ allowSpawn: false })
  return c.request('POST', path, { body: JSON.stringify(body) })
}

/**
 * A call's answer, or its failure in the call's own words: a refused or
 * failed call prints its errno and exits 1, with the policy's reason on a
 * line of its own. Mirrors Python's `answer`.
 */
export async function answer(r: Response): Promise<unknown> {
  if (r.status >= 400) {
    const error = errorOf(await r.clone().text())
    if (error?.errno !== undefined) {
      process.stderr.write(`${error.message} (${error.errno})\n`)
      if (error.refusal) process.stderr.write(`policy denied: ${error.refusal.reason}\n`)
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

const text = (result: unknown): string => Buffer.from(String(result), 'base64').toString('utf-8')

const lines = (result: unknown): string => (result as string[]).join('\n')

const HUMAN: Readonly<Record<string, (result: unknown) => string>> = {
  getxattr: text,
  readdir: lines,
  list_files: lines,
  listxattr: lines,
  readlink: String,
}

async function value(call: VfsCall, name: string, given: unknown): Promise<unknown> {
  if (call.params[name] === BYTES) {
    const data = typeof given === 'string' ? Buffer.from(given) : await buffer(process.stdin)
    return data.toString('base64')
  }
  if (call.params[name] === OWNER && typeof given === 'string' && /^\d+$/.test(given))
    return Number(given)
  return given
}

/**
 * Write a read's bytes to stdout as they arrive, as they are, so a big or
 * binary file passes through whole. Mirrors Python's `_read_to_stdout`.
 */
async function readToStdout(target: Target, body: Record<string, unknown>): Promise<void> {
  const r = await post(target, 'vfs/read', { ...body, stream: true })
  if (r.status >= 400 || r.body === null) await answer(r)
  else await pipeline(Readable.fromWeb(r.body), process.stdout, { end: false })
}

function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * The `mirage workspace vfs <call>` command for one call: the call's required
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
      cmd.option(`--${name} <text>`, `The ${name} as text; stdin when absent`)
    } else if (call.params[name] === FLAG) {
      cmd.option(`--${name}`)
    } else if (call.params[name] === INTEGER || call.params[name] === SIZE) {
      cmd.option(`--${name} <n>`, `The ${name}`, Number)
    } else {
      cmd.option(`--${name} <value>`)
    }
  }
  cmd
    .option(WORKSPACE_FLAGS, WORKSPACE_HELP)
    .option('-s, --session <id>', 'Session id')
    .option('--explain', 'Say what the call would do; run nothing')
  // A read prints the file's bytes as they arrive; --json keeps the JSON answer.
  const streams = call.name === 'read'
  if (streams) cmd.option('--json', 'Print the JSON answer, the bytes in base64')
  cmd.action(async (...given: unknown[]) => {
    const opts = given[positional.length] as Target & Record<string, unknown>
    const body: Record<string, unknown> = {}
    for (const [i, name] of positional.entries()) {
      body[name] = call.params[name] === INTEGER ? Number(given[i]) : given[i]
    }
    for (const name of Object.keys(call.params)) {
      if (positional.includes(name)) continue
      const raw = opts[camel(name)]
      if (call.params[name] === BYTES || raw !== undefined)
        body[name] = await value(call, name, raw)
    }
    if (streams && opts.json !== true && opts.explain !== true) {
      await readToStdout(opts, body)
      return
    }
    const result = await answer(await post(opts, `vfs/${call.name}`, body))
    if (result !== null)
      emit(result, opts.explain === true ? (r) => explained(r as Answer) : HUMAN[call.name])
  })
}

/** `mirage workspace vfs <call>` for each `session.vfs` call. */
export function registerVfsCommands(parent: Command): void {
  const vfs = parent
    .command('vfs')
    .description("The session's VFS calls, one command per call, as POSIX names them.")
  for (const call of VFS_CALLS) command(vfs, call)
}
