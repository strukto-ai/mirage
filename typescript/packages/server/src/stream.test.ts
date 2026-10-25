import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import type { FastifyReply } from 'fastify'
import { expect, it, vi } from 'vitest'
import { ExecutionTable } from './jobs.ts'
import { ExecutionStatus } from '@struktoai/mirage-core/execution/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import type { ExecutionScope } from '@struktoai/mirage-core/workspace/execution'
import { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'
import type { JobConsole } from '@struktoai/mirage-core/shell/console/job_console'
import { MAX_FINISHED_JOBS } from './constants.ts'
import { UploadStdin } from './stdin.ts'
import { PAYLOAD_SIZE, record, shellResponse } from './stream.ts'

function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

const ENC = new TextEncoder()

function finished(): ExecuteResult {
  return new ExecuteResult(new Uint8Array(), new Uint8Array(), 0)
}

async function said(sink: JobConsole): Promise<ExecuteResult> {
  await sink.emit('stdout', ENC.encode('out'))
  await sink.emit('stderr', ENC.encode('err'))
  return finished()
}

async function failing(sink: JobConsole): Promise<ExecuteResult> {
  await sink.emit('stdout', ENC.encode('partial'))
  throw new Error('boom')
}

function replyFor(raw = new EventEmitter()): { reply: FastifyReply; body: () => Readable } {
  let source: Readable | undefined
  const reply = {
    raw,
    log: { error: vi.fn(), debug: vi.fn() },
    header: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: (body: Readable) => {
      source = body
      return reply
    },
  } as unknown as FastifyReply
  return {
    reply,
    body: () => {
      if (source === undefined) throw new Error('response did not send a stream')
      return source
    },
  }
}

async function lines(body: Readable): Promise<Record<string, unknown>[]> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

it('a record holds at most a payload of its event', () => {
  const data = Uint8Array.from({ length: PAYLOAD_SIZE * 2 + 256 }, (_, i) => i % 256)
  const records = Buffer.from(record('stdout', data))
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { stream: string; data: string })
  expect(records).toHaveLength(3)
  expect(records.every((r) => Object.keys(r).sort().join(',') === 'data,stream')).toBe(true)
  expect(records.every((r) => r.stream === 'stdout')).toBe(true)
  const parts = records.map((r) => Buffer.from(r.data, 'base64'))
  expect(parts.every((part) => part.byteLength <= PAYLOAD_SIZE)).toBe(true)
  expect(Buffer.concat(parts)).toEqual(Buffer.from(data))
})

// The line's events go out as its records, as they come, then the final
// record with its status.
it('sends each event then the final record', async () => {
  const table = new ExecutionTable()
  let opened!: (shell: ShellExecution) => void
  const execution = new Promise<ShellExecution | null>((resolve) => {
    opened = resolve
  })
  const job = table.submit(
    'workspace',
    'line',
    async (signal, scope) => {
      await scope.start()
      const shell = new ShellExecution(said, scope, signal)
      opened(shell)
      await shell.wait()
      return { exit_code: 0 }
    },
    'session',
  )
  const { reply, body } = replyFor()
  shellResponse(execution, table, job, reply, Promise.resolve(undefined), undefined)
  const records = await lines(body())
  expect(
    records.slice(0, 2).map((r) => [r.stream, Buffer.from(r.data as string, 'base64').toString()]),
  ).toEqual([
    ['stdout', 'out'],
    ['stderr', 'err'],
  ])
  expect(records[2]?.status).toBe('done')
  await table.close()
})

// A line that fails while it streams keeps what it sent, and its final
// record says how it ended.
it('a line that fails while streaming still sends the final record', async () => {
  const table = new ExecutionTable()
  let opened!: (shell: ShellExecution) => void
  const execution = new Promise<ShellExecution | null>((resolve) => {
    opened = resolve
  })
  const job = table.submit(
    'workspace',
    'line',
    async (signal, scope) => {
      await scope.start()
      const shell = new ShellExecution(failing, scope, signal)
      opened(shell)
      await shell.wait()
      return { exit_code: 0 }
    },
    'session',
  )
  const { reply, body } = replyFor()
  shellResponse(execution, table, job, reply, Promise.resolve(undefined), undefined)
  const records = await lines(body())
  expect(Buffer.from(records[0]?.data as string, 'base64').toString()).toBe('partial')
  expect(records.at(-1)).toMatchObject({ status: 'failed', error: 'Error: boom' })
  await table.close()
})

it('disconnect cancels the job and joins its cleanup before closing the transport', async () => {
  const entered = gate(),
    cleanup = gate(),
    release = gate()
  const table = new ExecutionTable()
  let opened!: (shell: ShellExecution) => void
  const execution = new Promise<ShellExecution | null>((resolve) => {
    opened = resolve
  })
  const job = table.submit(
    'workspace',
    'held',
    async (signal, scope) => {
      await scope.start()
      const shell = new ShellExecution(
        async (sink, stop) => {
          await sink.emit('stdout', ENC.encode('prefix'))
          entered.release()
          await new Promise<void>((resolve) => {
            stop.addEventListener(
              'abort',
              () => {
                resolve()
              },
              { once: true },
            )
          })
          return finished()
        },
        scope,
        signal,
      )
      opened(shell)
      try {
        await shell.wait()
      } finally {
        cleanup.release()
        await release.wait
      }
      return null
    },
    'session',
  )
  await entered.wait
  const raw = new EventEmitter()
  let source: Readable | undefined
  const log = { error: vi.fn(), debug: vi.fn() }
  const reply = {
    raw,
    log,
    header: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: (body: Readable) => {
      source = body
      return reply
    },
  } as unknown as FastifyReply
  shellResponse(execution, table, job, reply, Promise.resolve(undefined), undefined)
  if (source === undefined) throw new Error('response did not send a stream')
  const body = source
  let ended = false
  const reading = (async () => {
    for await (const chunk of body) expect(chunk).toBeDefined()
  })().finally(() => {
    ended = true
  })
  raw.emit('close')
  await cleanup.wait
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(ended).toBe(false)
  release.release()
  await reading
  expect(raw.listenerCount('close')).toBe(0)
  expect(table.get(job.id)?.status).toBe(ExecutionStatus.CANCELED)
  await table.close()
})

it('the final record does not wait for stdin to end', async () => {
  const uploaded = gate()
  const table = new ExecutionTable()
  const job = table.submit(
    'workspace',
    'true',
    async (_signal, scope) => {
      await scope.start()
      return { exit_code: 0 }
    },
    'session',
  )
  await table.wait(job.id)
  let source: Readable | undefined
  const reply = {
    raw: new EventEmitter(),
    log: { error: vi.fn(), debug: vi.fn() },
    header: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: (body: Readable) => {
      source = body
      return reply
    },
  } as unknown as FastifyReply
  const failed = uploaded.wait.then(() => undefined)
  shellResponse(Promise.resolve(null), table, job, reply, failed, new UploadStdin())
  if (source === undefined) throw new Error('response did not send a stream')
  const body = source
  const records: string[] = []
  let ended = false
  const reading = (async () => {
    for await (const chunk of body) records.push(Buffer.from(chunk as Uint8Array).toString())
    ended = true
  })()
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
  expect(JSON.parse(records.join('').trim().split('\n').at(-1) ?? '')).toMatchObject({
    status: 'done',
  })
  expect(ended).toBe(false)
  uploaded.release()
  await reading
  expect(ended).toBe(true)
  await table.close()
})

it('a hang-up after the final record ends the body', async () => {
  const hangUp = gate()
  const table = new ExecutionTable()
  const job = table.submit(
    'workspace',
    'true',
    async (_signal, scope) => {
      await scope.start()
      return { exit_code: 0 }
    },
    'session',
  )
  await table.wait(job.id)
  const raw = new EventEmitter()
  const log = { error: vi.fn(), debug: vi.fn() }
  let source: Readable | undefined
  const reply = {
    raw,
    log,
    header: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: (body: Readable) => {
      source = body
      return reply
    },
  } as unknown as FastifyReply
  const failed = hangUp.wait.then(() => new Error('aborted'))
  shellResponse(Promise.resolve(null), table, job, reply, failed, new UploadStdin())
  if (source === undefined) throw new Error('response did not send a stream')
  const body = source
  const records: string[] = []
  let ended = false
  const reading = (async () => {
    for await (const chunk of body) records.push(Buffer.from(chunk as Uint8Array).toString())
    ended = true
  })()
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
  expect(records.join('')).toContain('"status":"done"')
  expect(ended).toBe(false)
  raw.emit('close')
  hangUp.release()
  await reading
  expect(
    records
      .join('')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { status: string }).status),
  ).toEqual(['done'])
  expect(log.error).not.toHaveBeenCalled()
  expect(table.get(job.id)?.status).toBe(ExecutionStatus.DONE)
  await table.close()
})

it('an upload that failed first fails the final record', async () => {
  const table = new ExecutionTable()
  const job = table.submit(
    'workspace',
    'true',
    async (_signal, scope) => {
      await scope.start()
      return { exit_code: 0 }
    },
    'session',
  )
  await table.wait(job.id)
  let source: Readable | undefined
  const reply = {
    raw: new EventEmitter(),
    log: { error: vi.fn(), debug: vi.fn() },
    header: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: (body: Readable) => {
      source = body
      return reply
    },
  } as unknown as FastifyReply
  const failed = Promise.resolve(new Error('bad multipart body'))
  await failed
  shellResponse(Promise.resolve(null), table, job, reply, failed, undefined)
  if (source === undefined) throw new Error('response did not send a stream')
  const records: string[] = []
  for await (const chunk of source) records.push(Buffer.from(chunk as Uint8Array).toString())
  expect(JSON.parse(records.join(''))).toEqual({
    status: 'failed',
    result: null,
    error: 'bad multipart body',
  })
  await table.close()
})

it('an upload failing while its cleanup runs fails the record', async () => {
  const held = gate()
  const table = new ExecutionTable()
  const job = table.submit(
    'workspace',
    'true',
    async (_signal, scope) => {
      await scope.start()
      return { exit_code: 0 }
    },
    'session',
  )
  await table.wait(job.id)
  let source: Readable | undefined
  const reply = {
    raw: new EventEmitter(),
    log: { error: vi.fn(), debug: vi.fn() },
    header: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: (body: Readable) => {
      source = body
      return reply
    },
  } as unknown as FastifyReply
  const stdin = new UploadStdin()
  stdin.discard = () => held.wait
  const error = new Error('stdin part too large')
  const failed = stdin.fail(error).then(() => error)
  shellResponse(Promise.resolve(null), table, job, reply, failed, stdin)
  if (source === undefined) throw new Error('response did not send a stream')
  const body = source
  const records: string[] = []
  const reading = (async () => {
    for await (const chunk of body) records.push(Buffer.from(chunk as Uint8Array).toString())
  })()
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
  held.release()
  await reading
  expect(JSON.parse(records.join(''))).toEqual({
    status: 'failed',
    result: null,
    error: 'stdin part too large',
  })
  await table.close()
})

it('the final record survives its eviction', async () => {
  const finish = gate()
  const table = new ExecutionTable()
  const work = async (_signal: AbortSignal, scope: ExecutionScope): Promise<JsonValue> => {
    await scope.start()
    await finish.wait
    return { exit_code: 0 }
  }
  const job = table.submit('workspace', 'held', work, 'session')
  let source: Readable | undefined
  const reply = {
    raw: new EventEmitter(),
    log: { error: vi.fn(), debug: vi.fn() },
    header: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: (body: Readable) => {
      source = body
      return reply
    },
  } as unknown as FastifyReply
  shellResponse(Promise.resolve(null), table, job, reply, Promise.resolve(undefined), undefined)
  for (let i = 0; i < MAX_FINISHED_JOBS; i++) table.submit('workspace', 'other', work, 'session')
  if (source === undefined) throw new Error('response did not send a stream')
  const body = source
  const records: string[] = []
  const reading = (async () => {
    for await (const chunk of body) records.push(Buffer.from(chunk as Uint8Array).toString())
  })()
  finish.release()
  await reading
  expect(table.get(job.id)).toBeNull()
  expect(JSON.parse(records.join('').trim().split('\n').at(-1) ?? '')).toMatchObject({
    status: 'done',
  })
  await table.close()
})
