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
import { recordStatus } from '@struktoai/mirage-core/workspace/executor/statement'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { ServerChannel } from 'ssh2'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { ACCOUNT_OPTION, PROFILE_OPTION } from './constants.ts'
import { ChannelInput, ChannelOutput, Mark, channelStdin, deliver } from './stream.ts'

const AGENT_ID = 'ssh'
const INTERRUPTED = 130
const FALLBACK_PROMPT = 'mirage$ '
const LOGIN_HOME = '/'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function prompt(cwd: string): string {
  return `mirage:${cwd}$ `
}

export function newSessionId(): string {
  return `ssh_${randomBytes(6).toString('hex')}`
}

/**
 * Whether a typed line asks the interactive shell to leave. mirage
 * contains `exit` within the line it runs, so the shell reads the words
 * instead: `exit` or `exit N` leaves, while `exit 1 2` is bash's "too many
 * arguments" and stays.
 */
export function endsShell(line: string): boolean {
  const words = line
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
  return words[0] === 'exit' && words.length <= 2
}

export interface Endpoint {
  address: string
  port: number
}

/** What the server knows about one channel's login. */
export interface ChannelRequest {
  username: string
  /** The login key's `mirage-profile` values; empty when it has none. */
  profile: readonly string[]
  /** The login key's `mirage-account` values; empty when it has none. */
  account: readonly string[]
  command: string | null
  term: string | null
  peer: Endpoint | null
  local: Endpoint | null
}

/**
 * The environment sshd hands a login: who, from where, on what. `HOME` is
 * `/`, where every session starts, and the user is the workspace id, since
 * that is the name the client logged in as.
 */
export function loginEnv(request: ChannelRequest): Record<string, string> {
  const env: Record<string, string> = {
    HOME: LOGIN_HOME,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
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
 * line, so every name clears the session's `pre_session` gate like any
 * `export` would, and a name the profile already set keeps its value.
 */
export async function openSession(
  ws: Workspace,
  sessionId: string,
  env: Record<string, string> = {},
  profile: string | null = null,
): Promise<void> {
  await ws.ensureSessionsLoaded()
  const session = ws.createSession(sessionId, profile === null ? {} : { profile })
  try {
    const missing = Object.entries(env).filter(([name]) => !(name in session.env))
    if (missing.length === 0) return
    const line = `export ${missing.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')}`
    await ws.shell(line, { sessionId, record: false })
  } catch (err) {
    await ws.closeSession(sessionId)
    throw err
  }
}

/**
 * Leave `$?` at 130 after a Ctrl-C, as an interactive bash does: an
 * aborted line is the caller's outcome, and an interactive shell is the
 * caller here, whose outcome for an interrupted foreground line is
 * 128 + SIGINT.
 */
function stampInterrupt(ws: Workspace, sessionId: string): void {
  recordStatus(ws.getSession(sessionId), INTERRUPTED)
}

/**
 * One SSH session channel, run as one mirage session of its own.
 *
 * A command channel (`ssh host cmd`) runs its line and ends, and a shell
 * channel reads lines until `exit` or end of input, printing a prompt when
 * the client asked for a terminal. The session is fresh per channel, as
 * each channel is a fresh process under sshd, so a `cd` never leaks from
 * one channel to another and two channels never wait on each other's
 * lines.
 */
export class ShellChannel {
  private readonly tty: boolean
  private readonly input: ChannelInput
  private readonly output: ChannelOutput
  private running: AbortController | null = null
  private lost = false

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly entry: WorkspaceEntry,
    private readonly sessionId: string,
    private readonly channel: ServerChannel,
    private readonly request: ChannelRequest,
  ) {
    this.tty = request.term !== null
    this.input = new ChannelInput(channel, this.tty)
    this.output = new ChannelOutput(channel, this.tty)
  }

  /** A signal request from the client, delivered like Ctrl-C. */
  signal(): void {
    this.input.interruptReceived()
  }

  private live(): boolean {
    const wid = this.entry.id
    return this.registry.has(wid) && this.registry.get(wid) === this.entry
  }

  private interrupt(): void {
    this.running?.abort()
  }

  private currentPrompt(): string {
    if (!this.live()) return FALLBACK_PROMPT
    return prompt(this.entry.runner.ws.getSession(this.sessionId).cwd)
  }

  /** Run the channel to its end and return the exit status to report. */
  async serve(): Promise<number> {
    this.input.start()
    const onClose = (): void => {
      this.lost = true
      this.interrupt()
    }
    this.channel.once('close', onClose)
    try {
      if (this.request.command !== null) return await this.run(this.request.command)
      return await this.repl()
    } finally {
      this.channel.off('close', onClose)
      this.input.close()
      if (this.live()) await this.entry.runner.ws.closeSession(this.sessionId)
    }
  }

  /**
   * Run one line and stream its output. Ctrl-C and a dropped connection
   * abort the line where it is; the status is then 130.
   */
  async run(line: string): Promise<number> {
    if (!this.live()) {
      await this.output.write(encoder.encode('mirage: the workspace is gone\n'), true)
      return 1
    }
    const ws = this.entry.runner.ws
    const controller = new AbortController()
    this.running = controller
    this.input.onInterrupt(() => {
      controller.abort()
    })
    try {
      const execution = await ws.shell(line, {
        sessionId: this.sessionId,
        stdin: channelStdin(this.input),
        agentId: AGENT_ID,
        signal: controller.signal,
        stream: true,
      })
      try {
        const result = await deliver(execution, (data, stderr) => this.output.write(data, stderr))
        return result.exitCode
      } finally {
        await execution.close()
      }
    } catch (err) {
      if (controller.signal.aborted) {
        if (this.lost) return INTERRUPTED
        if (this.live()) stampInterrupt(ws, this.sessionId)
        if (this.tty) await this.output.write(encoder.encode('^C\n'))
        return INTERRUPTED
      }
      if (this.lost) return 1
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`ssh: line failed on ${this.entry.id}: ${message}`)
      await this.output.write(encoder.encode(`mirage: ${message}\n`), true)
      return 1
    } finally {
      this.input.onInterrupt(null)
      this.running = null
    }
  }

  /** Read and run lines until `exit` or end of input. */
  async repl(): Promise<number> {
    let status = 0
    while (!this.lost) {
      if (this.tty) await this.output.write(encoder.encode(this.currentPrompt()))
      const item = await this.input.readline()
      if (item === Mark.LIMIT) {
        await this.output.write(encoder.encode('mirage: shell input line too long\n'), true)
        return 1
      }
      if (item === Mark.EOF) {
        if (this.tty) await this.output.write(encoder.encode('logout\n'))
        return status
      }
      if (item === Mark.INTERRUPT) {
        if (this.tty) await this.output.write(encoder.encode('^C\n'))
        status = INTERRUPTED
        if (this.live()) stampInterrupt(this.entry.runner.ws, this.sessionId)
        continue
      }
      const line = decoder.decode(item).replace(/[\r\n]+$/, '')
      if (line.trim() === '') continue
      status = await this.run(line)
      if (endsShell(line) || !this.live()) return status
    }
    return status
  }
}

function refuse(channel: ServerChannel, message: string): void {
  channel.stderr.write(`mirage: ${message}\n`)
  channel.exit(1)
  channel.end()
}

/**
 * The login's workspace and a fresh session opened in it, under the login
 * key's profile, else the workspace's default, with the environment an
 * `ssh` login gets. A login whose workspace is out of reach, or whose
 * session cannot open, is told why and its channel exits 1: null.
 * Mirrors Python's `open_login`.
 */
export async function openLogin(
  registry: WorkspaceRegistry,
  channel: ServerChannel,
  request: ChannelRequest,
  door: string,
): Promise<[WorkspaceEntry, string] | null> {
  const entry = loginEntry(registry, request.username, request.account)
  if (entry === null) {
    refuse(channel, `no such workspace: ${request.username}`)
    return null
  }
  const sessionId = newSessionId()
  try {
    await openSession(entry.runner.ws, sessionId, loginEnv(request), keyProfile(request.profile))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`${door}: cannot open a session on ${request.username}: ${message}`)
    refuse(channel, `cannot open a session: ${message}`)
    return null
  }
  return [entry, sessionId]
}

/**
 * Serve one session channel: a command, or an interactive shell. The SSH
 * username names the workspace. `started` receives the running channel,
 * so the server can hand it the client's signal requests; a refused
 * channel never reaches it.
 */
export async function handleChannel(
  registry: WorkspaceRegistry,
  channel: ServerChannel,
  request: ChannelRequest,
  started: (shell: ShellChannel) => void,
): Promise<void> {
  const opened = await openLogin(registry, channel, request, 'ssh')
  if (opened === null) return
  const [entry, sessionId] = opened
  const shell = new ShellChannel(registry, entry, sessionId, channel, request)
  started(shell)
  const status = await shell.serve()
  channel.exit(status)
  channel.end()
}

/** Refuse a subsystem other than SFTP and codex-exec, in the voice of every refusal. */
export function refuseSubsystem(channel: ServerChannel, name: string): void {
  refuse(channel, `unsupported subsystem: ${name}`)
}
