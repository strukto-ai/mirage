import { BytePipe } from '@struktoai/mirage-core/io/pipe'
import {
  ABORT_JOIN_MS,
  atDeadline,
  hasAborted,
  runWithDeadline,
} from '@struktoai/mirage-core/utils/abort'
import { encodeBase64 } from '@struktoai/mirage-core/utils/base64'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import type { RouteReply } from '../routes.ts'
import { encodeMessage, endStream, type StartCommand } from './connect.ts'
import * as constants from './constants.ts'
import type { LiveProcess, Sandbox } from './sandbox.ts'

export function remainingSeconds(deadline: number | null): number | null {
  return deadline === null ? null : Math.max(0, deadline - performance.now()) / 1000
}

export function processResponse(
  sandbox: Sandbox,
  command: StartCommand,
  deadlineAt: number | null,
  pid: number,
  closed: AbortSignal,
  reply: RouteReply,
): RouteReply {
  const canceled = new AbortController()
  const connection = AbortSignal.any([closed, canceled.signal])
  const deadline = new AbortController()
  let grace: ReturnType<typeof setTimeout> | undefined
  const closeStalledStream = (): void => {
    grace ??= setTimeout(() => {
      stall()
    }, ABORT_JOIN_MS)
  }
  const expire = (): void => {
    deadline.abort(new DOMException(constants.DEADLINE_MESSAGE, 'TimeoutError'))
    closeStalledStream()
  }
  const signal = AbortSignal.any([connection, deadline.signal, sandbox.stopped])
  let execution: ShellExecution | undefined

  async function* events(): AsyncGenerator<Uint8Array> {
    if (hasAborted(connection)) return
    const timeout = remainingSeconds(deadlineAt)
    if (timeout === 0) {
      yield endStream('deadline_exceeded', constants.DEADLINE_MESSAGE)
      return
    }
    const disarm = timeout === null ? undefined : atDeadline(timeout, expire)
    let process: LiveProcess | undefined
    const stdin = command.stdin ? new BytePipe() : undefined
    try {
      execution = await runWithDeadline(timeout, expire, () => {
        if (sandbox.stopped.aborted) {
          throw new DOMException('command canceled', 'AbortError')
        }
        return sandbox.workspace.shell(command.line, {
          sessionId: sandbox.workspace.defaultSessionId,
          cwd: command.cwd ?? constants.HOME,
          env: { ...sandbox.envVars, ...command.envs },
          ...(stdin === undefined ? {} : { stdin: stdin.stream() }),
          signal,
          stream: true,
        })
      })
      if (sandbox.stopped.aborted) execution.cancel()
      process = { command, execution, stdin, killed: false }
      sandbox.processes.set(pid, process)
      execution.onSettled(() => {
        sandbox.processes.delete(pid)
        stdin?.closeReader()
      })
      yield encodeMessage({ start: { pid } })
      for await (const event of execution.events) {
        if (signal.aborted) break
        yield encodeMessage({ data: { [event.stream]: encodeBase64(event.data) } })
      }
      const { exitCode } = await execution.wait()
      if (hasAborted(connection)) return
      if (sandbox.stopped.aborted) {
        yield endStream('canceled', 'command canceled')
        return
      }
      if (deadline.signal.aborted || remainingSeconds(deadlineAt) === 0) {
        yield endStream('deadline_exceeded', constants.DEADLINE_MESSAGE)
        return
      }
      disarm?.()
      yield encodeMessage({
        end: { exitCode, exited: true, status: 'exited' },
      })
      yield endStream()
    } catch (error) {
      if (hasAborted(connection)) return
      if (deadline.signal.aborted) {
        yield endStream('deadline_exceeded', constants.DEADLINE_MESSAGE)
      } else if (process?.killed === true) {
        yield encodeMessage({ end: { exitCode: 137, exited: true, status: 'signal: killed' } })
        yield endStream()
      } else if (
        sandbox.stopped.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        yield endStream('canceled', 'command canceled')
      } else {
        console.error('sandbox command failed:', error)
        yield endStream('internal', 'command failed')
      }
    } finally {
      disarm?.()
      stdin?.closeReader()
      await execution?.close()
    }
  }

  const revoke = (): void => {
    execution?.cancel()
    closeStalledStream()
  }
  const source = events()
  let open = true
  const finish = (error?: unknown): void => {
    if (!open) return
    open = false
    if (error !== undefined && !connection.aborted && !sandbox.stopped.aborted) {
      console.debug('sandbox command transport closed', error)
    }
    clearTimeout(grace)
    sandbox.stopped.removeEventListener('abort', revoke)
    closed.removeEventListener('abort', disconnect)
    canceled.abort()
    void source.return(undefined).catch((cause: unknown) => {
      console.debug('sandbox command events closed', cause)
    })
  }
  let stall = (): void => undefined
  let disconnect = (): void => undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stall = () => {
        if (!open) return
        const error = new DOMException('command stream stalled', 'AbortError')
        controller.error(error)
        finish(error)
      }
      disconnect = () => {
        if (!open) return
        controller.error(closed.reason)
        finish()
      }
    },
    async pull(controller) {
      let next: IteratorResult<Uint8Array>
      try {
        next = await source.next()
      } catch (error) {
        if (open) controller.error(error)
        finish(error)
        return
      }
      if (!open) return
      if (next.done === true) {
        controller.close()
        finish()
      } else {
        controller.enqueue(next.value)
      }
    },
    cancel() {
      finish()
    },
  })
  if (sandbox.stopped.aborted) revoke()
  else sandbox.stopped.addEventListener('abort', revoke, { once: true })
  if (closed.aborted) disconnect()
  else closed.addEventListener('abort', disconnect, { once: true })
  return reply.type(constants.CONNECT_STREAM).send(body)
}
