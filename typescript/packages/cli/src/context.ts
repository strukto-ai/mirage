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

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { readDaemonTable } from '@struktoai/mirage-server/daemon_config'
import { mirageHome } from '@struktoai/mirage-server/paths'
import type { Command } from 'commander'
import { ENV_CONTEXT, ENV_DAEMON_PORT, ENV_WORKSPACE } from './env.ts'
import { emit, fail, formatTable } from './output.ts'

type Env = Record<string, string | undefined>

const CONTEXTS_FILE = 'contexts.json'
const LOGINS_DIR = 'logins'
const LEGACY_LOGIN_FILE = 'login.json'
export const LOCAL = 'local'
export const HOSTED = 'strukto'
export const HOSTED_URL = 'https://api.strukto.ai'
const DEFAULT_PORT = 8765
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** A context that does not exist, or one that cannot be changed. */
export class ContextError extends Error {
  override readonly name = 'ContextError'
}

/**
 * One server the CLI talks to, with what it remembers there: its URL
 * (empty for `local`, whose URL follows the daemon's port), the team the
 * login acts for if the server names one, and the workspace commands use
 * when given none.
 */
interface Context {
  url: string
  team: string | null
  workspace: string | null
}

/** The contexts file: which context is current, and every context; `local` is always there. */
export interface Contexts {
  current: string
  contexts: Record<string, Context>
}

function emptyContext(): Context {
  return { url: '', team: null, workspace: null }
}

function contextsPath(env: Env): string {
  return join(mirageHome(env), CONTEXTS_FILE)
}

/**
 * Where a context's login is kept. A login kept before contexts existed
 * belongs to `local`, whose URL it was made for, and moves there on first
 * use.
 */
export function loginPath(name: string, env: Env = process.env): string {
  const path = join(mirageHome(env), LOGINS_DIR, `${name}.json`)
  const legacy = join(mirageHome(env), LEGACY_LOGIN_FILE)
  if (name === LOCAL && existsSync(legacy) && !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    renameSync(legacy, path)
  }
  return path
}

/** A context name, refused unless it is safe as a file name. */
export function checkName(name: string): string {
  if (!NAME.test(name)) {
    throw new ContextError(
      `invalid context name '${name}': use lowercase letters, digits, '.', '_' and '-'`,
    )
  }
  return name
}

/** The contexts file; with none, only `local`. */
export function readContexts(env: Env = process.env): Contexts {
  const path = contextsPath(env)
  const found: Contexts = { current: LOCAL, contexts: {} }
  if (existsSync(path)) {
    let raw: { current?: string; contexts?: Record<string, Partial<Context>> }
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8')) as typeof raw
    } catch (e) {
      throw new ContextError(`malformed ${path}: ${(e as Error).message}`)
    }
    found.current = raw.current ?? LOCAL
    for (const [name, entry] of Object.entries(raw.contexts ?? {})) {
      found.contexts[name] = { ...emptyContext(), ...entry }
    }
  }
  found.contexts[LOCAL] ??= emptyContext()
  return found
}

/** Store the contexts file whole, readable by this user only. */
export function writeContexts(contexts: Contexts, env: Env = process.env): void {
  const path = contextsPath(env)
  mkdirSync(dirname(path), { recursive: true })
  const staged = join(dirname(path), `.${CONTEXTS_FILE}.${String(process.pid)}`)
  const fd = openSync(staged, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(contexts, null, 2) + '\n')
  } finally {
    closeSync(fd)
  }
  renameSync(staged, path)
}

/**
 * The context this command uses: `--context` or `$MIRAGE_CONTEXT`, else
 * the file's current one. Throws `ContextError` when there is none by
 * that name.
 */
export function currentName(contexts: Contexts, env: Env = process.env): string {
  const fromEnv = env[ENV_CONTEXT]
  const name = fromEnv !== undefined && fromEnv !== '' ? fromEnv : contexts.current
  if (!(name in contexts.contexts)) {
    throw new ContextError(`no context '${name}'; run \`mirage context list\``)
  }
  return name
}

/**
 * The `local` context's URL: the one it logged in to, else config.toml's
 * `url` (until that key goes), else this machine at the port a spawned
 * daemon listens on.
 */
export function localUrl(
  table: Record<string, string>,
  contexts: Contexts,
  env: Env = process.env,
): string {
  const fromEnv = env[ENV_DAEMON_PORT]
  const port =
    fromEnv !== undefined && fromEnv !== ''
      ? fromEnv
      : table.port !== undefined && table.port !== ''
        ? table.port
        : String(DEFAULT_PORT)
  const own = contexts.contexts[LOCAL]?.url ?? ''
  if (own !== '') return own
  if (table.url !== undefined && table.url !== '') return table.url
  return `http://127.0.0.1:${port}`
}

/** The workspace a command uses when given none: `$MIRAGE_WORKSPACE`, else the current context's. */
export function currentWorkspace(env: Env = process.env): string | null {
  const fromEnv = env[ENV_WORKSPACE]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const contexts = readContexts(env)
  return contexts.contexts[currentName(contexts, env)]?.workspace ?? null
}

/** The workspace to act on: `-w`, else `$MIRAGE_WORKSPACE`, else the current context's. */
export function resolveWorkspace(given: string | undefined): string {
  const found = given !== undefined && given !== '' ? given : currentWorkspace()
  if (found === null || found === '') {
    fail('no workspace selected · run `mirage workspace use <id>` or pass -w', 2)
  }
  return found
}

/**
 * Say on a terminal which context and team a command acted in, as
 * `strukto · team acme · created demo`; `name` is the current context
 * when left out.
 */
export function header(action: string, name?: string): void {
  if (!process.stderr.isTTY) return
  const contexts = readContexts()
  const used = name ?? currentName(contexts)
  const team = contexts.contexts[used]?.team ?? null
  const parts = [used, ...(team !== null && team !== '' ? [`team ${team}`] : []), action]
  process.stderr.write(parts.join(' · ') + '\n')
}

/** Make a workspace the current context's. */
export function useWorkspace(workspaceId: string): void {
  const contexts = readContexts()
  const name = currentName(contexts)
  contexts.contexts[name] = {
    ...(contexts.contexts[name] ?? emptyContext()),
    workspace: workspaceId,
  }
  writeContexts(contexts)
}

interface ContextRow {
  name: string
  url: string
  team: string | null
  workspace: string | null
  current: boolean
}

export function registerContextCommands(program: Command): void {
  const context = program
    .command('context')
    .description('The servers the CLI talks to: list, switch, forget.')

  context
    .command('list')
    .description('List the contexts; the current one is marked.')
    .action(() => {
      const contexts = readContexts()
      const current = currentName(contexts)
      const table = readDaemonTable(mirageHome(process.env))
      const rows: ContextRow[] = Object.keys(contexts.contexts)
        .sort(compareCodePoints)
        .map((name) => {
          const entry = contexts.contexts[name] ?? emptyContext()
          return {
            name,
            url: entry.url !== '' ? entry.url : localUrl(table, contexts),
            team: entry.team,
            workspace: entry.workspace,
            current: name === current,
          }
        })
      emit(rows, (items) =>
        formatTable(
          ['', 'NAME', 'URL', 'TEAM', 'WORKSPACE'],
          items.map((r) => [r.current ? '*' : '', r.name, r.url, r.team ?? '', r.workspace ?? '']),
        ),
      )
    })

  context
    .command('use')
    .argument('<name>', 'Context name')
    .description('Make a context the current one.')
    .action((name: string) => {
      const contexts = readContexts()
      if (!(name in contexts.contexts)) {
        throw new ContextError(`no context '${name}'; run \`mirage context list\``)
      }
      contexts.current = name
      writeContexts(contexts)
      header('now current', name)
      emit({ current: name }, () => `Using context ${name}.`)
    })

  context
    .command('delete')
    .argument('<name>', 'Context name')
    .description('Forget a context and its login; `local` stays.')
    .action((name: string) => {
      if (name === LOCAL) throw new ContextError('the local context cannot be deleted')
      const contexts = readContexts()
      if (!(name in contexts.contexts)) {
        throw new ContextError(`no context '${name}'; run \`mirage context list\``)
      }
      contexts.contexts = Object.fromEntries(
        Object.entries(contexts.contexts).filter(([n]) => n !== name),
      )
      if (contexts.current === name) contexts.current = LOCAL
      writeContexts(contexts)
      rmSync(join(mirageHome(process.env), LOGINS_DIR, `${name}.json`), { force: true })
      emit({ deleted: name }, () => `Deleted context ${name}.`)
    })
}
