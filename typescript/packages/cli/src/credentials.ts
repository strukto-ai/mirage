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
  statSync,
  writeSync,
} from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { mirageHome } from '@struktoai/mirage-server/paths'
import {
  CONTEXT_NAME,
  CONTEXTS_FILE,
  LOCAL,
  LOCK_RETRY_SECONDS,
  LOCK_STALE_SECONDS,
  LOCK_WAIT_SECONDS,
  LOGINS_DIR,
} from './constants.ts'
import { ENV_CONTEXT } from './env.ts'

type Env = Record<string, string | undefined>

export const LOGIN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const REFRESH_MARGIN_SECONDS = 60

/**
 * One server the CLI talks to, with what it remembers there: its URL
 * (empty for `local`, whose URL follows the daemon's port), the team the
 * login acts for if the server names one, and the workspace commands use
 * when given none.
 */
export interface Context {
  url: string
  team: string | null
  workspace: string | null
}

/** The contexts file: which context is current, and every context; `local` is always there. */
export interface Contexts {
  current: string
  contexts: Record<string, Context>
}

/** A context that does not exist, or one that cannot be changed. */
export class ContextError extends Error {
  override readonly name = 'ContextError'
}

export function emptyContext(): Context {
  return { url: '', team: null, workspace: null }
}

function contextsPath(env: Env): string {
  return join(mirageHome(env), CONTEXTS_FILE)
}

/** Where a context's login is kept. */
export function loginPath(name: string, env: Env = process.env): string {
  return join(mirageHome(env), LOGINS_DIR, `${name}.json`)
}

/** A context name, refused unless it is safe as a file name. */
export function checkName(name: string): string {
  if (!CONTEXT_NAME.test(name)) {
    throw new ContextError(
      `invalid context name '${name}': use lowercase letters, digits, '.', '_' and '-'`,
    )
  }
  return name
}

/** The contexts file; with none, only `local`. */
export function readContexts(env: Env = process.env): Contexts {
  const path = contextsPath(env)
  const found: Contexts = {
    current: LOCAL,
    contexts: Object.create(null) as Record<string, Context>,
  }
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
  if (!Object.hasOwn(found.contexts, LOCAL)) found.contexts[LOCAL] = emptyContext()
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

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.ino === b.ino && a.mtimeNs === b.mtimeNs
}

/**
 * Remove a stale lock, as one waiter at a time: the one that creates the
 * `.break` file, and only while the lock is still the file it saw, so a
 * lock another command just took is never removed.
 */
function breakStaleLock(path: string, seen: BigIntStats): void {
  const breaker = `${path}.break`
  let fd: number
  try {
    fd = openSync(breaker, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const held = statOrNull(breaker)
    if (held !== null && Date.now() / 1000 - Number(held.mtimeMs) / 1000 > LOCK_STALE_SECONDS) {
      rmSync(breaker, { force: true })
    }
    return
  }
  try {
    const now = statOrNull(path)
    if (now !== null && sameFile(now, seen)) rmSync(path, { force: true })
  } finally {
    closeSync(fd)
    rmSync(breaker, { force: true })
  }
}

function statOrNull(path: string): BigIntStats | null {
  try {
    return statSync(path, { bigint: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Run `fn` holding the contexts file's lock, so one command at a time
 * reads, changes and writes it. A lock older than `LOCK_STALE_SECONDS` was
 * left by a command that died, and one waiter removes it (`breakStaleLock`);
 * throws `ContextError` when another command held it for `LOCK_WAIT_SECONDS`.
 */
async function contextsLock<T>(fn: () => T, env: Env = process.env): Promise<T> {
  const path = join(mirageHome(env), `${CONTEXTS_FILE}.lock`)
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_SECONDS * 1000
  let fd: number
  for (;;) {
    try {
      fd = openSync(path, 'wx', 0o600)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const seen = statOrNull(path)
    if (seen === null) continue
    if (Date.now() / 1000 - Number(seen.mtimeMs) / 1000 > LOCK_STALE_SECONDS) {
      breakStaleLock(path, seen)
      continue
    }
    if (Date.now() > deadline) {
      throw new ContextError(`${path} is held by another mirage command`)
    }
    await sleep(LOCK_RETRY_SECONDS * 1000)
  }
  try {
    return fn()
  } finally {
    closeSync(fd)
    rmSync(path, { force: true })
  }
}

/** Read, change and write the contexts file under its lock, so a command running at the same time loses nothing. */
export async function updateContexts<T>(
  change: (contexts: Contexts) => T,
  env: Env = process.env,
): Promise<T> {
  return contextsLock(() => {
    const contexts = readContexts(env)
    const result = change(contexts)
    writeContexts(contexts, env)
    return result
  }, env)
}

/** The command that logs a context in again. */
export function loginCommand(url: string, name: string): string {
  return `mirage login ${url} --name ${name}`
}

/**
 * The context this command uses: `--context` or `$MIRAGE_CONTEXT`, else
 * the file's current one. Throws `ContextError` when there is none by
 * that name.
 */
export function currentName(contexts: Contexts, env: Env = process.env): string {
  const fromEnv = env[ENV_CONTEXT]
  const name = fromEnv !== undefined && fromEnv !== '' ? fromEnv : contexts.current
  if (!Object.hasOwn(contexts.contexts, name)) {
    throw new ContextError(`no context '${name}'; run \`mirage context list\``)
  }
  return name
}

/** The login cannot give a token: it is too old, or the issuer refused to refresh it. */
export class LoginError extends Error {
  override readonly name = 'LoginError'
}

/**
 * What `mirage login` keeps, for the one server a context is: the
 * server the token is for (it goes nowhere else), the bearer token, when
 * the user signed in (the login ends 30 days later, however often it was
 * refreshed), the refresh token (null for a pasted token), when the
 * access token ends if known, the OAuth client that signed in, and where
 * a refresh goes.
 */
export interface Login {
  url: string
  access_token: string
  logged_in_at: number
  refresh_token: string | null
  expires_at: number | null
  client_id: string | null
  token_endpoint: string | null
}

/** When the user has to log in again. */
export function renewBy(login: Login): number {
  const ends = login.logged_in_at + LOGIN_MAX_AGE_SECONDS
  if (login.refresh_token === null && login.expires_at !== null) {
    return Math.min(ends, login.expires_at)
  }
  return ends
}

/** The current context's login file. */
function currentLoginPath(env: Record<string, string | undefined> = process.env): string {
  return loginPath(currentName(readContexts(env), env), env)
}

/** The stored login, or null when there is none. */
export function readLogin(path: string = currentLoginPath()): Login | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8')) as Login
}

/** Store a login, readable by this user only. */
export function writeLogin(login: Login, path: string = currentLoginPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const staged = join(dirname(path), `.${basename(path)}.${String(process.pid)}`)
  const fd = openSync(staged, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(login, null, 2))
  } finally {
    closeSync(fd)
  }
  renameSync(staged, path)
}

/** Forget the stored login; returns the login removed, or null when there was none. */
export function removeLogin(path: string = currentLoginPath()): Login | null {
  const login = readLogin(path)
  rmSync(path, { force: true })
  return login
}

/** A JWT's claims, unchecked, to show and to time; empty when it is not a JWT. */
export function tokenClaims(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) return {}
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf-8'))
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** An OAuth endpoint's JSON object, or empty when it sent none. */
export async function jsonBody(reply: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await reply.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** When a token endpoint's access token ends, or null when it gave no `expires_in`. */
export function endsAt(body: Record<string, unknown>, now: number): number | null {
  const expiresIn = body.expires_in
  return typeof expiresIn === 'number' && expiresIn > 0 ? now + expiresIn : null
}

/**
 * The login's access token, refreshed first when it is about to end;
 * `login` is updated in place and stored at `path` on a refresh. Throws
 * `LoginError` when the login is over 30 days old, its token ended with
 * nothing to refresh it, or the issuer refused the refresh.
 */
export async function freshToken(login: Login, path: string = currentLoginPath()): Promise<string> {
  const now = Date.now() / 1000
  const again = `run \`${loginCommand(login.url, basename(path, '.json'))}\` to log in again`
  if (now >= login.logged_in_at + LOGIN_MAX_AGE_SECONDS) {
    throw new LoginError(`the login is 30 days old; ${again}`)
  }
  if (login.expires_at === null || now < login.expires_at - REFRESH_MARGIN_SECONDS) {
    return login.access_token
  }
  if (login.refresh_token === null || login.token_endpoint === null || login.client_id === null) {
    throw new LoginError(`the token has expired; ${again}`)
  }
  let reply: Response
  try {
    reply = await fetch(login.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: login.refresh_token,
        client_id: login.client_id,
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new LoginError(`could not reach the issuer: ${String(error)}`)
  }
  const body = await jsonBody(reply)
  if (reply.status !== 200 || typeof body.access_token !== 'string') {
    const reason = typeof body.error === 'string' ? body.error : String(reply.status)
    throw new LoginError(`the issuer refused to refresh the login (${reason}); ${again}`)
  }
  login.access_token = body.access_token
  if (typeof body.refresh_token === 'string' && body.refresh_token !== '') {
    login.refresh_token = body.refresh_token
  }
  login.expires_at = endsAt(body, now)
  writeLogin(login, path)
  return login.access_token
}
