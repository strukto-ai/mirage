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

import type { ServerChannel } from 'ssh2'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { stillServed } from './login.ts'
import { ChannelOutput, deliver } from './stream.ts'

const decoder = new TextDecoder()

/**
 * Run `line` with a channel as its stdin and its stdout, as a login's lines
 * run, so it reaches what they reach. The channel's bytes are the line's
 * input and its output is the channel's, while its stderr is only logged.
 * The pipe ends with the line, and the channel closing hangs the line up
 * (`Workspace.hangup`). The session is the pipe's: it closes when the line
 * has ended. Resolves to the line's status, 1 when it failed to run.
 * Mirrors Python's `serve_pipe`.
 */
export async function servePipe(
  registry: WorkspaceRegistry,
  entry: WorkspaceEntry,
  sessionId: string,
  line: string,
  channel: ServerChannel,
  gone: AbortSignal,
  door: string,
): Promise<number> {
  const ws = entry.runner.ws
  const output = new ChannelOutput(channel, false)
  let hung = false
  const onClose = (): void => {
    if (hung || !stillServed(registry, entry)) return
    hung = true
    ws.hangup(sessionId).catch((err: unknown) => {
      console.debug(`ssh: ${door} hangup failed`, err)
    })
  }
  channel.once('close', onClose)
  gone.addEventListener('abort', onClose, { once: true })
  if (gone.aborted) onClose()
  try {
    const execution = await ws.shell(line, {
      sessionId,
      stdin: channel.iterator({ destroyOnReturn: false }) as AsyncIterable<Uint8Array>,
      record: false,
      stream: true,
    })
    try {
      const result = await deliver(execution, async (data, stderr) => {
        if (stderr) {
          console.debug(`ssh: ${door}: ${decoder.decode(data)}`)
          return
        }
        await output.write(data)
      })
      console.debug(`ssh: ${door} ended: ${String(result.exitCode)}`)
      return result.exitCode
    } finally {
      await execution.close()
    }
  } catch (err) {
    console.debug(`ssh: ${door} ended`, err)
    return 1
  } finally {
    channel.off('close', onClose)
    gone.removeEventListener('abort', onClose)
    if (stillServed(registry, entry)) await ws.closeSession(sessionId)
  }
}
