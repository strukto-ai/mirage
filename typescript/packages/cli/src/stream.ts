import { Buffer } from 'node:buffer'
import type { Writable } from 'node:stream'
import type { Refusal } from '@struktoai/mirage-core/types'
import { SaidWindow } from '@struktoai/mirage-core/workspace/tools/io_text'
import type { DaemonClient } from './client.ts'
import { exitCodeFromResponse, handleResponse } from './output.ts'

const MAX_RECORD_BYTES = 1024 * 1024

interface Completion {
  status: 'done' | 'failed' | 'canceled'
  result: Record<string, unknown> | null
  error: string | null
}

async function write(output: Writable, data: Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason as Error)
    }
    signal.addEventListener('abort', abort, { once: true })
    output.write(data, (error) => {
      signal.removeEventListener('abort', abort)
      if (error !== null && error !== undefined) reject(error)
      else resolve()
    })
  })
}

/** Decode bounded NDJSON records and await each output write. */
export async function consumeStream(
  source: AsyncIterable<Uint8Array>,
  stdout: (data: Uint8Array) => Promise<void>,
  stderr: (data: Uint8Array) => Promise<void>,
): Promise<Completion> {
  let pending = Buffer.alloc(0)
  let terminal: Completion | undefined
  for await (const chunk of source) {
    pending = Buffer.concat([pending, chunk])
    let newline: number
    while ((newline = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      if (line.length > MAX_RECORD_BYTES) throw new Error('daemon stream record is too large')
      const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
      if (
        typeof record !== 'object' ||
        record === null ||
        Array.isArray(record) ||
        terminal !== undefined
      )
        throw new Error('invalid daemon stream record')
      const value = record as Record<string, unknown>
      if (value.stream === 'stdout' || value.stream === 'stderr') {
        if (typeof value.data !== 'string') throw new Error('invalid daemon stream bytes')
        const raw = Buffer.from(value.data, 'base64')
        if (raw.toString('base64') !== value.data) throw new Error('invalid daemon stream bytes')
        await (value.stream === 'stdout' ? stdout(raw) : stderr(raw))
      } else if (
        value.status === 'done' ||
        value.status === 'failed' ||
        value.status === 'canceled'
      ) {
        if (
          (value.result !== null &&
            (typeof value.result !== 'object' || Array.isArray(value.result))) ||
          (value.error !== null && typeof value.error !== 'string')
        )
          throw new Error('invalid daemon stream completion')
        terminal = value as unknown as Completion
      } else throw new Error('invalid daemon stream record')
    }
    if (pending.length > MAX_RECORD_BYTES) throw new Error('daemon stream record is too large')
  }
  if (pending.length !== 0 || terminal === undefined)
    throw new Error('daemon stream ended without a completion record')
  return terminal
}

/** The refusal record off a completion's result, in core's shape. */
function refusalOf(result: Record<string, unknown> | null): Refusal | null {
  const raw = result?.refusal as
    | {
        kind: Refusal['kind']
        reason: string
        policy: string
        scope: Refusal['scope']
        ask_id: string | null
      }
    | null
    | undefined
  if (raw === null || raw === undefined) return null
  return {
    kind: raw.kind,
    reason: raw.reason,
    policy: raw.policy,
    scope: raw.scope,
    askId: raw.ask_id,
  }
}

/**
 * Upload stdin and drain output concurrently, retaining cancellation through
 * the final record. When a policy refused part of the line, its reason
 * follows the output as one line on stderr, as the SSH door prints it.
 */
export async function streamShell(
  client: DaemonClient,
  path: string,
  payload: Record<string, unknown>,
  piped: boolean,
  jsonOutput = false,
): Promise<number> {
  const stop = new AbortController()
  const state = { interrupted: false }
  const interrupt = (): void => {
    state.interrupted = true
    stop.abort()
  }
  const outputFailure = (error: Error): void => {
    stop.abort(error)
  }
  process.stdout.on('error', outputFailure)
  process.stderr.on('error', outputFailure)
  process.on('SIGINT', interrupt)
  try {
    const response = piped
      ? await client.requestUpload(
          'POST',
          path,
          payload,
          { name: 'stdin', data: process.stdin },
          stop.signal,
        )
      : await client.request('POST', path, {
          body: JSON.stringify(payload),
          signal: stop.signal,
          timeoutMs: null,
        })
    if (response.status === 499) return 130
    if (!response.ok) await handleResponse(response)
    if (response.body === null) throw new Error('daemon stream ended without a completion record')
    const capturedStdout: Uint8Array[] = []
    const capturedStderr: Uint8Array[] = []
    const said = new SaidWindow()
    const terminal = await consumeStream(
      response.body,
      (data) => {
        if (jsonOutput) {
          capturedStdout.push(data)
          return Promise.resolve()
        }
        said.add(data, false)
        return write(process.stdout, data, stop.signal)
      },
      (data) => {
        if (jsonOutput) {
          capturedStderr.push(data)
          return Promise.resolve()
        }
        said.add(data, true)
        return write(process.stderr, data, stop.signal)
      },
    )
    if (terminal.status === 'failed') throw new Error(`shell failed: ${String(terminal.error)}`)
    if (terminal.status === 'canceled') return 130
    const line = jsonOutput ? '' : said.refusalLine(refusalOf(terminal.result))
    if (line !== '') await write(process.stderr, Buffer.from(line), stop.signal)
    if (jsonOutput) {
      const result = {
        ...terminal.result,
        stdout: Buffer.concat(capturedStdout).toString('utf8'),
        stderr: Buffer.concat(capturedStderr).toString('utf8'),
      }
      await write(process.stdout, Buffer.from(JSON.stringify(result, null, 2) + '\n'), stop.signal)
    }
    return exitCodeFromResponse(terminal.result)
  } catch (error) {
    if (state.interrupted) return 130
    const failure: unknown = stop.signal.aborted ? stop.signal.reason : error
    if (failure instanceof Error && 'code' in failure && failure.code === 'EPIPE') return 141
    throw error
  } finally {
    stop.abort()
    if (piped) process.stdin.destroy()
    process.off('SIGINT', interrupt)
    process.stdout.off('error', outputFailure)
    process.stderr.off('error', outputFailure)
  }
}
