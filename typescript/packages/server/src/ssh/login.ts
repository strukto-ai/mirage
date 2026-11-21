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

import { randomBytes } from 'node:crypto'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import type { ServerChannel } from 'ssh2'
import { refused } from '../metrics.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { ACCOUNT_OPTION, PROFILE_OPTION } from './constants.ts'
import { LoginRefusedError } from './errors.ts'
import type { ChannelRequest, Login } from './types.ts'

export function newSessionId(): string {
  return `ssh_${randomBytes(6).toString('hex')}`
}

/**
 * The environment sshd hands a login: who, from where, on what. The user is
 * the workspace id, since that is the name the client logged in as. `HOME`
 * is the session's own, its user's home.
 */
export function loginEnv(request: ChannelRequest): Record<string, string> {
  const env: Record<string, string> = {
    USER: request.username,
    LOGNAME: request.username,
  }
  const { peer, local } = request
  if (peer !== null && local !== null) {
    env.SSH_CLIENT = `${peer.address} ${String(peer.port)} ${String(local.port)}`
    env.SSH_CONNECTION = `${peer.address} ${String(peer.port)} ${local.address} ${String(local.port)}`
  }
  if (request.term !== null && request.term !== '') env.TERM = request.term
  return env
}

/**
 * The profile the login's authorized key is bound to, if any. The key's
 * line names it with `mirage-profile="<name>"`; a key without the option
 * runs under the workspace's default profile. A bare, empty or repeated
 * option is refused.
 */
function keyOption(values: readonly string[], option: string, what: string): string | null {
  if (values.length === 0) return null
  const [name] = values
  if (values.length !== 1 || name === undefined || name === '') {
    throw new Error(`${option} must name exactly one ${what}`)
  }
  return name
}

export function keyProfile(values: readonly string[]): string | null {
  return keyOption(values, PROFILE_OPTION, 'profile')
}

/**
 * The account the login's key belongs to, if any: its line's
 * `mirage-account="<name>"`. The account may open only the workspaces it
 * owns; a key without the option has no account.
 */
function keyAccount(values: readonly string[]): string | null {
  return keyOption(values, ACCOUNT_OPTION, 'account')
}

/**
 * The workspace a login may open, else null. One rule for every channel
 * kind: the key's account must be allowed the workspace its username
 * names. A key whose account option is malformed opens nothing.
 */
export function loginEntry(
  registry: WorkspaceRegistry,
  workspaceId: string,
  account: readonly string[],
): WorkspaceEntry | null {
  let name: string | null
  try {
    name = keyAccount(account)
  } catch (err) {
    console.warn(
      `ssh: refusing ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
  return registry.visible(workspaceId, name)
}

/**
 * Create the session a channel runs as, under `profile` (the login key's),
 * else the workspace's default profile; a profile the workspace does not
 * define is refused. The login environment is exported by an unrecorded
 * line, so a hidden or protected name is refused as any `export` of it
 * would be, and a name the profile already set keeps its value. A
 * server shutting down, or a workspace at the server's `maxSessions`,
 * refuses it with EAGAIN.
 */
export async function openSession(
  ws: Workspace,
  sessionId: string,
  env: Record<string, string> = {},
  profile: string | null = null,
  registry: WorkspaceRegistry | null = null,
): Promise<void> {
  await ws.ensureSessionsLoaded()
  if (registry?.draining === true) {
    refused('shutting_down')
    throw Object.assign(new Error('server is shutting down'), { code: 'EAGAIN' })
  }
  const cap = registry?.maxSessions ?? null
  if (cap !== null && ws.listSessions().length >= cap) {
    refused('max_sessions')
    throw Object.assign(new Error(`workspace is at max_sessions (${String(cap)})`), {
      code: 'EAGAIN',
    })
  }
  const session = ws.createSession(sessionId, profile === null ? {} : { profile })
  try {
    const missing = Object.entries(env).filter(([name]) => !(name in session.env))
    if (missing.length === 0) return
    const line = `export ${missing.map(([k, v]) => `${k}=${singleQuote(v)}`).join(' ')}`
    await ws.shell(line, { sessionId, record: false })
  } catch (err) {
    await ws.closeSession(sessionId)
    throw err
  }
}

/**
 * The login's workspace and a fresh session opened in it, under the login
 * key's profile, else the workspace's default. A workspace out of reach, or
 * a session that cannot open, throws `LoginRefusedError`. Mirrors Python's
 * `login_session`.
 */
export async function loginSession(
  registry: WorkspaceRegistry,
  login: Login,
  env: Record<string, string>,
  door: string,
): Promise<[WorkspaceEntry, string]> {
  const entry = loginEntry(registry, login.username, login.account)
  if (entry === null) throw new LoginRefusedError(`no such workspace: ${login.username}`)
  const sessionId = newSessionId()
  try {
    await openSession(entry.runner.ws, sessionId, env, keyProfile(login.profile), registry)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`${door}: cannot open a session on ${login.username}: ${message}`)
    throw new LoginRefusedError(`cannot open a session: ${message}`)
  }
  return [entry, sessionId]
}

/** Tell the client why its channel cannot run, and exit it 1. */
export function refuse(channel: ServerChannel, message: string): void {
  channel.stderr.write(`mirage: ${message}\n`)
  channel.exit(1)
  channel.end()
}

/**
 * The login's workspace and a fresh session opened in it (`loginSession`),
 * with the environment an `ssh` login gets. A login refused is told why
 * and its channel exits 1: null. Mirrors Python's `open_login`.
 */
export async function openLogin(
  registry: WorkspaceRegistry,
  channel: ServerChannel,
  request: ChannelRequest,
  door: string,
): Promise<[WorkspaceEntry, string] | null> {
  try {
    return await loginSession(registry, request, loginEnv(request), door)
  } catch (err) {
    if (!(err instanceof LoginRefusedError)) throw err
    refuse(channel, err.message)
    return null
  }
}

/**
 * Whether the registry still serves the workspace a channel opened in, not
 * one deleted, or created again under its id since.
 */
export function stillServed(registry: WorkspaceRegistry, entry: WorkspaceEntry): boolean {
  return registry.has(entry.id) && registry.get(entry.id) === entry
}
