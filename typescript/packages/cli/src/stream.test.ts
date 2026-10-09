import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client.ts'
import { consumeStream, streamShell } from './stream.ts'

function record(fields: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(fields) + '\n')
}

describe('stream response', () => {
  it('preserves binary channels and deferred exit status across split records', async () => {
    const out: Uint8Array[] = []
    const err: Uint8Array[] = []
    const body = Buffer.concat([
      record({ stream: 'stdout', data: Buffer.from([0, 255, 97]).toString('base64') }),
      record({ stream: 'stderr', data: Buffer.from('oops\n').toString('base64') }),
      record({ status: 'done', result: { kind: 'io', exit_code: 7 }, error: null }),
    ])
    async function* source() {
      for (const byte of body) yield await Promise.resolve(Buffer.from([byte]))
    }
    const terminal = await consumeStream(
      source(),
      (data) => {
        out.push(data)
        return Promise.resolve()
      },
      (data) => {
        err.push(data)
        return Promise.resolve()
      },
    )
    expect(terminal.result?.exit_code).toBe(7)
    expect(Buffer.concat(out)).toEqual(Buffer.from([0, 255, 97]))
    expect(Buffer.concat(err).toString()).toBe('oops\n')
  })

  it.each([
    Buffer.alloc(0),
    record({ stream: 'stdout', data: 'YQ==' }),
    record({ status: 'done', result: {}, error: null }).subarray(0, -1),
    record({ stream: 'stdout', data: '???' }),
    Buffer.concat([
      record({ status: 'done', result: {}, error: null }),
      record({ stream: 'stdout', data: 'YQ==' }),
    ]),
    record({ status: 'done', result: {}, error: 1 }),
    Buffer.concat([
      record({ channel: 'stdout', data: 'YQ==' }),
      record({ status: 'done', result: {}, error: null }),
    ]),
  ])('rejects malformed or truncated records', async (body) => {
    const writes: Uint8Array[] = []
    async function* source() {
      yield await Promise.resolve(body)
    }
    const write = (data: Uint8Array): Promise<void> => {
      writes.push(data)
      return Promise.resolve()
    }
    await expect(consumeStream(source(), write, write)).rejects.toThrow()
  })

  it('waits for output backpressure before pulling another record', async () => {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const pulled: string[] = []
    async function* source() {
      pulled.push('output')
      yield await Promise.resolve(record({ stream: 'stdout', data: 'YQ==' }))
      pulled.push('done')
      yield record({ status: 'done', result: {}, error: null })
    }
    const write = async (): Promise<void> => {
      enter()
      await released
    }
    const task = consumeStream(source(), write, write)
    await entered
    expect(pulled).toEqual(['output'])
    release()
    await task
    expect(pulled).toEqual(['output', 'done'])
  })
})

describe('stream HTTP lifecycle', () => {
  it.each(['complete', 'cancel', 'broken'] as const)(
    'receives output while stdin is open (%s)',
    async (mode) => {
      const cancel = mode === 'cancel'
      const broken = mode === 'broken'
      const received: Buffer[] = []
      let started = false
      const server = createServer((req, res) => {
        const head: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
          head.push(chunk)
          if (!started && Buffer.concat(head).includes(Buffer.from('filename="stdin.bin"'))) {
            started = true
            res.writeHead(200, { 'content-type': 'application/x-ndjson' })
            res.write(record({ stream: 'stdout', data: 'cmVhZHkK' }))
          } else received.push(chunk)
        })
        req.on('end', () => {
          res.write(record({ stream: 'stderr', data: 'AP8=' }))
          res.end(record({ status: 'done', result: { kind: 'io', exit_code: 7 }, error: null }))
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      const client = new DaemonClient({
        url: `http://127.0.0.1:${String(port)}`,
        authToken: '',
        idleGraceSeconds: 30,
      })
      const stdin = new PassThrough()
      const out: Buffer[] = []
      const err: Buffer[] = []
      let first!: () => void
      const output = new Promise<void>((resolve) => {
        first = resolve
      })
      const stdout = new Writable({
        write(data: Buffer, _encoding, done) {
          out.push(data)
          first()
          done(broken ? Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) : undefined)
        },
      })
      const stderr = new Writable({
        write(data: Buffer, _encoding, done) {
          err.push(data)
          done()
        },
      })
      vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin)
      vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as typeof process.stdout)
      vi.spyOn(process, 'stderr', 'get').mockReturnValue(stderr as typeof process.stderr)
      const listeners = process.listenerCount('SIGINT')
      try {
        const task = streamShell(client, '/shell?stream=true', { command: 'cat' }, true)
        await output
        expect(Buffer.concat(out)).toEqual(Buffer.from('ready\n'))
        expect(stdin.writableEnded).toBe(false)
        if (cancel) process.emit('SIGINT')
        else if (!broken) stdin.end(Buffer.from([0, 255, 97]))
        expect(await task).toBe(cancel ? 130 : broken ? 141 : 7)
        expect(stdin.destroyed).toBe(true)
        if (!cancel && !broken) {
          expect(Buffer.concat(err)).toEqual(Buffer.from([0, 255]))
          expect(Buffer.concat(received).includes(Buffer.from([0, 255, 97]))).toBe(true)
        }
        expect(process.listenerCount('SIGINT')).toBe(listeners)
      } finally {
        stdin.destroy()
        vi.restoreAllMocks()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error)
            else resolve()
          }),
        )
      }
    },
  )
})
