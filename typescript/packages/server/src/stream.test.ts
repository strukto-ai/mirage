import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import type { FastifyReply } from 'fastify'
import { expect, it, vi } from 'vitest'
import { RAMExecutionStore } from '@struktoai/mirage-core/execution/ram'
import type { ExecutionRecord } from '@struktoai/mirage-core/execution/types'
import { CAPACITY } from '@struktoai/mirage-core/io/pipe'
import { Channel } from '@struktoai/mirage-core/shell/console/types'
import { JobTable } from './jobs.ts'
import { UploadStdin } from './stdin.ts'
import { ShellOutput, shellResponse } from './stream.ts'

function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

it('a larger output buffer accepts more without a reader', async () => {
  const output = new ShellOutput(CAPACITY * 2)
  const data = Uint8Array.from({ length: CAPACITY }, (_, i) => i % 256)
  await output.emit(Channel.STDOUT, data)
  output.pipe.end()
  const encoded: Uint8Array[] = []
  for await (const chunk of output.pipe.stream()) encoded.push(chunk)
  const records = Buffer.concat(encoded)
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { stream: string; data: string })
  expect(records.every((record) => Object.keys(record).sort().join(',') === 'data,stream')).toBe(
    true,
  )
  expect(records.every((record) => record.stream === 'stdout')).toBe(true)
  expect(Buffer.concat(records.map((record) => Buffer.from(record.data, 'base64')))).toEqual(
    Buffer.from(data),
  )
  await output.close()
})

it('ending a blocked write leaves only complete wire records', async () => {
  const output = new ShellOutput()
  const writing = output.emit(Channel.STDOUT, new Uint8Array(65536).fill(120))
  const interrupted = expect(writing).rejects.toThrow()
  await new Promise((resolve) => setTimeout(resolve, 0))
  output.pipe.end()
  await interrupted
  const encoded: Uint8Array[] = []
  for await (const chunk of output.pipe.stream()) encoded.push(chunk)
  const lines = Buffer.concat(encoded).toString()
  expect(lines.endsWith('\n')).toBe(true)
  const records = lines
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { stream: string; data: string })
  expect(records.every((record) => Object.keys(record).sort().join(',') === 'data,stream')).toBe(
    true,
  )
  expect(records.every((record) => record.stream === 'stdout')).toBe(true)
  const prefix = Buffer.concat(records.map((record) => Buffer.from(record.data, 'base64')))
  expect(prefix.byteLength).toBeGreaterThan(0)
  expect(prefix.byteLength).toBeLessThan(65536)
  expect(prefix).toEqual(Buffer.alloc(prefix.byteLength, 120))
  await output.close()
})

it('disconnect joins cleanup and closes transport even when the record store fails', async () => {
  const entered = gate(),
    cleanup = gate(),
    release = gate()
  class BrokenStore extends RAMExecutionStore {
    offline = false
    override async get(id: string): Promise<ExecutionRecord | null> {
      if (this.offline) throw new Error('storage unavailable')
      return super.get(id)
    }
  }
  const store = new BrokenStore()
  const table = new JobTable(store)
  const output = new ShellOutput()
  const closed = vi.spyOn(output, 'close')
  const job = await table.submit(
    'workspace',
    'held',
    async (signal, scope) => {
      await scope.start()
      await output.emit(Channel.STDOUT, new TextEncoder().encode('prefix'))
      entered.release()
      try {
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'))
            },
            { once: true },
          )
        })
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
  shellResponse(output, table, job, reply, Promise.resolve(undefined), undefined)
  if (source === undefined) throw new Error('response did not send a stream')
  const body = source
  const reading = (async () => {
    for await (const chunk of body) expect(chunk).toBeDefined()
  })()
  const failed = expect(reading).rejects.toThrow('storage unavailable')
  store.offline = true
  raw.emit('close')
  await cleanup.wait
  expect(closed).not.toHaveBeenCalled()
  release.release()
  await failed
  expect(closed).toHaveBeenCalledOnce()
  expect(raw.listenerCount('close')).toBe(0)
  expect(log.error).toHaveBeenCalled()
  store.offline = false
  await table.close()
  await store.close()
})

it('the final record waits for the upload to end', async () => {
  const uploaded = gate()
  const table = new JobTable(new RAMExecutionStore())
  const job = await table.submit(
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
  shellResponse(new ShellOutput(), table, job, reply, failed, new UploadStdin())
  if (source === undefined) throw new Error('response did not send a stream')
  const body = source
  const records: string[] = []
  const reading = (async () => {
    for await (const chunk of body) records.push(Buffer.from(chunk as Uint8Array).toString())
  })()
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
  expect(records.join('')).not.toContain('"status"')
  uploaded.release()
  await reading
  expect(JSON.parse(records.join('').trim().split('\n').at(-1) ?? '')).toMatchObject({
    status: 'done',
  })
  await table.close()
})
