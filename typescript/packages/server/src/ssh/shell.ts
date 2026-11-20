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

import { context } from '@opentelemetry/api'
import { recordStatus } from '@struktoai/mirage-core/workspace/executor/statement'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { INTERRUPTED_STATUS } from '@struktoai/mirage-core/shell/constants'
import { rstripChars } from '@struktoai/mirage-core/utils/text'
import type { ServerChannel } from 'ssh2'
import { traceHeaders } from '../env.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { requestContext } from '../trace.ts'
import { openLogin, stillServed } from './login.ts'
import { ChannelInput, ChannelOutput, Mark, channelStdin, deliver } from './stream.ts'
import type { ChannelRequest } from './types.ts'

const FALLBACK_PROMPT = 'mirage$ '

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function prompt(cwd: string): string {
  return `mirage:${cwd}$ `
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

/**
 * Leave `$?` at 130 after a Ctrl-C, as an interactive bash does: an
 * aborted line is the caller's outcome, and an interactive shell is the
 * caller here, whose outcome for an interrupted foreground line is
 * 128 + SIGINT.
 */
function stampInterrupt(ws: Workspace, sessionId: string): void {
  recordStatus(ws.getSession(sessionId), INTERRUPTED_STATUS)
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
 *
 * A dropped connection ends the channel's lines as it ends a process under
 * sshd: on a terminal it hangs them up, and without one it sends nothing,
 * so the line runs on without input until it writes, where sshd's pipe
 * would break, and is hung up then.
 */
export class ShellChannel {
  private readonly tty: boolean
  private readonly input: ChannelInput
  private readonly output: ChannelOutput
  private running: AbortController | null = null
  private lost = false
  private hung = false

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
    return stillServed(this.registry, this.entry)
  }

  private interrupt(): void {
    this.running?.abort()
  }

  /** Hang the channel's lines up (`Workspace.hangup`), once. */
  private hangUp(): void {
    if (this.hung || !this.live()) return
    this.hung = true
    this.entry.runner.ws.hangup(this.sessionId).catch((err: unknown) => {
      console.debug('ssh: hangup failed', err)
    })
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
      if (!this.live()) this.interrupt()
      else if (this.tty) this.hangUp()
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
   * Run one line and stream its output. Ctrl-C aborts the line where it
   * is, and a dropped connection hangs it up (`Workspace.hangup`); the
   * status is then 130.
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
        signal: controller.signal,
        stream: true,
      })
      try {
        const result = await deliver(execution, (data, stderr) => {
          if (!this.lost) return this.output.write(data, stderr)
          this.hangUp()
          return Promise.resolve()
        })
        return result.exitCode
      } finally {
        await execution.close()
      }
    } catch (err) {
      if (controller.signal.aborted) {
        if (this.lost) return INTERRUPTED_STATUS
        if (this.live()) stampInterrupt(ws, this.sessionId)
        if (this.tty) await this.output.write(encoder.encode('^C\n'))
        return INTERRUPTED_STATUS
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
        status = INTERRUPTED_STATUS
        if (this.live()) stampInterrupt(this.entry.runner.ws, this.sessionId)
        continue
      }
      const line = rstripChars(decoder.decode(item), '\r\n')
      if (line.trim() === '') continue
      status = await this.run(line)
      if (endsShell(line) || !this.live()) return status
    }
    return status
  }
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
  const status = await context.with(requestContext(traceHeaders(request.env)), () => shell.serve())
  channel.exit(status)
  channel.end()
}
