import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPACITY } from '@struktoai/mirage-core/io/pipe'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { expect, test } from 'vitest'
import { buildApp } from '../app.ts'
import { AuthMode } from '../auth/index.ts'
import { CONNECT_STREAM } from '../e2b/process.ts'
import { e2bListener } from './e2b_test_support.ts'

const PREFIX = '/process.Process/'
const JSON_HEADERS = { 'content-type': 'application/json' }
const StartEvent = z.object({ event: z.object({ start: z.object({ pid: z.number() }) }) })

function startBody(line: string): Buffer {
  const payload = Buffer.from(
    JSON.stringify({ process: { cmd: '/bin/bash', args: ['-l', '-c', line] }, stdin: true }),
  )
  const frame = Buffer.alloc(5 + payload.length)
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return frame
}

test('controls live commands within a sandbox', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'mirage-e2b-commands-'))
  const app = buildApp({
    stateRoot,
    e2bPort: 8766,
    authConfig: { mode: AuthMode.Token, bearerToken: 'server-key' },
  })
  try {
    const origin = await e2bListener(app).listen({ host: '127.0.0.1', port: 0 })
    async function sandbox() {
      const response = await e2bListener(app).inject({
        method: 'POST',
        url: '/v2/sandboxes',
        headers: { 'x-api-key': 'server-key' },
        payload: {},
      })
      expect(response.statusCode).toBe(201)
      const lease = response.json<{ sandboxID: string; envdAccessToken: string }>()
      return {
        'e2b-sandbox-id': lease.sandboxID,
        'e2b-sandbox-port': '49983',
        'x-access-token': lease.envdAccessToken,
      }
    }
    const headers = await sandbox()
    const other = await sandbox()

    function control(method: string, payload: unknown, addressed = headers) {
      return e2bListener(app).inject({
        method: 'POST',
        url: PREFIX + method,
        headers: { ...addressed, ...JSON_HEADERS },
        payload: JSON.stringify(payload),
      })
    }

    async function run(onStart?: (pid: number) => Promise<void>, timeout?: number) {
      const response = await fetch(origin + PREFIX + 'Start', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': CONNECT_STREAM,
          ...(timeout === undefined ? {} : { 'connect-timeout-ms': String(timeout) }),
        },
        body: new Uint8Array(startBody('cat')),
        signal: AbortSignal.timeout(3000),
      })
      expect(response.status).toBe(200)
      if (response.body === null) throw new Error('missing command stream')
      const frames: unknown[] = []
      let buffered = Buffer.alloc(0)
      for await (const chunk of response.body) {
        buffered = Buffer.concat([buffered, chunk])
        while (buffered.length >= 5) {
          const end = 5 + buffered.readUInt32BE(1)
          if (end > buffered.length) break
          const frame: unknown = JSON.parse(buffered.subarray(5, end).toString())
          buffered = buffered.subarray(end)
          frames.push(frame)
          const start = StartEvent.safeParse(frame)
          if (start.success) await onStart?.(start.data.event.start.pid)
        }
      }
      expect(buffered.length).toBe(0)
      return frames
    }

    const echoed = await run(async (pid) => {
      const listed = await control('List', {})
      expect(listed.json()).toMatchObject({
        processes: [{ pid, config: { args: ['-l', '-c', 'cat'] } }],
      })
      const process = { pid }
      const missing = await control('SendSignal', { process, signal: 'SIGNAL_SIGKILL' }, other)
      expect(missing.statusCode).toBe(404)
      const wrongSignal = await control('SendSignal', { process, signal: 15 })
      expect(wrongSignal.json<{ code: string }>().code).toBe('unimplemented')
      const excess = Buffer.alloc(CAPACITY + 1).toString('base64')
      const tooLarge = await control('SendInput', { process, input: { stdin: excess } })
      expect(tooLarge.json<{ code: string }>().code).toBe('resource_exhausted')
      const written = await control('SendInput', { process, input: { stdin: 'AP8K' } })
      expect(written.statusCode).toBe(200)
      expect((await control('CloseStdin', { process })).statusCode).toBe(200)
    })
    expect(echoed[1]).toEqual({ event: { data: { stdout: 'AP8K' } } })
    expect(echoed.at(-2)).toMatchObject({ event: { end: { exitCode: 0 } } })
    expect((await control('List', {})).json()).toEqual({ processes: [] })

    const killed = await run(async (pid) => {
      expect((await control('SendSignal', { process: { pid }, signal: 9 })).statusCode).toBe(200)
    })
    expect(killed.at(-2)).toMatchObject({ event: { end: { exitCode: 137 } } })
    expect((await control('List', {})).json()).toEqual({ processes: [] })

    const expired = await run(undefined, 50)
    expect(expired.at(-1)).toMatchObject({ error: { code: 'deadline_exceeded' } })
    expect((await control('List', {})).json()).toEqual({ processes: [] })

    const revoked = await run(async () => {
      const result = await e2bListener(app).inject({
        method: 'DELETE',
        url: `/sandboxes/${headers['e2b-sandbox-id']}`,
        headers: { 'x-api-key': 'server-key' },
      })
      expect(result.statusCode).toBe(204)
    })
    expect(revoked.at(-1)).toMatchObject({ error: { code: 'canceled' } })
    expect((await control('List', {})).statusCode).toBe(401)
  } finally {
    await app.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})
