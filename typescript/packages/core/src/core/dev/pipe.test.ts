import { expect, it } from 'vitest'
import { DevicePipe } from './pipe.ts'
import { PathSpec } from '../../types.ts'

const PATH = PathSpec.fromStrPath('/dev/fd/63')
const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function drain(endpoint: DevicePipe, seen: string[]): Promise<void> {
  for await (const chunk of endpoint.stream(PATH)) seen.push(DEC.decode(chunk))
}

it('preserves pending bytes and rejects the wrong direction', async () => {
  const endpoint = new DevicePipe(true)
  await endpoint.pipe.write(ENC.encode('abcdef'))
  endpoint.pipe.end()
  expect(DEC.decode(await endpoint.read(PATH, 2))).toBe('ab')
  let rest = ''
  for await (const chunk of endpoint.stream(PATH)) rest += DEC.decode(chunk)
  expect(rest).toBe('cdef')
  await expect(endpoint.write(new Uint8Array([1]), PATH)).rejects.toMatchObject({ code: 'EBADF' })
  await expect(new DevicePipe(false).read(PATH)).rejects.toMatchObject({ code: 'EBADF' })
})

it('concurrent readers take turns by chunk', async () => {
  const endpoint = new DevicePipe(true)
  const left: string[] = []
  const right: string[] = []
  const readers = Promise.all([drain(endpoint, left), drain(endpoint, right)])
  for (const chunk of ['one', 'two', 'three']) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await endpoint.pipe.write(ENC.encode(chunk))
  }
  endpoint.pipe.end()
  await readers
  expect([...left, ...right].sort()).toEqual(['one', 'three', 'two'])
})

it('abandoned reader keeps the read end open', async () => {
  const endpoint = new DevicePipe(true)
  await endpoint.pipe.write(ENC.encode('first'))
  await endpoint.pipe.write(ENC.encode('second'))
  endpoint.pipe.end()
  const stream = endpoint.stream(PATH)
  const first = await stream.next()
  expect(first.done === true ? '' : DEC.decode(first.value)).toBe('first')
  await stream.return(undefined)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(endpoint.pipe.closedReader).toBe(false)
  expect(DEC.decode(await endpoint.read(PATH))).toBe('second')
})

it('cancelled reader leaves its chunk to the next reader', async () => {
  const endpoint = new DevicePipe(true)
  const abort = new AbortController()
  const waiting = endpoint.stream(PATH, abort.signal).next()
  await new Promise((resolve) => setTimeout(resolve, 0))
  abort.abort()
  await expect(waiting).rejects.toThrow()
  await endpoint.pipe.write(ENC.encode('data'))
  endpoint.pipe.end()
  expect(endpoint.pipe.closedReader).toBe(false)
  expect(DEC.decode(await endpoint.read(PATH))).toBe('data')
})
