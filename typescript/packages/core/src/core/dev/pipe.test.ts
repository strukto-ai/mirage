import { expect, it } from 'vitest'
import { DevicePipe } from './pipe.ts'
import { CAPACITY } from '../../io/pipe.ts'
import { PipeClosed } from '../../io/errors.ts'
import { PathSpec } from '../../types.ts'
import { DevFiles } from '../../vfs/dev/store.ts'

const PATH = PathSpec.fromStrPath('/dev/fd/63')
it('bounds buffered bytes and wakes a writer when the reader closes', async () => {
  const endpoint = new DevicePipe(true)
  let done = false
  const writing = endpoint.pipe.write(new Uint8Array(CAPACITY * 4)).finally(() => {
    done = true
  })
  const rejected = expect(writing).rejects.toBeInstanceOf(PipeClosed)
  await Promise.resolve()
  expect(endpoint.pipe.bufferedBytes).toBeLessThanOrEqual(CAPACITY)
  expect(done).toBe(false)
  expect(await endpoint.read(PATH, 3)).toHaveLength(3)
  const stream = endpoint.stream(PATH)
  const next = await stream.next()
  expect(next.done).toBe(false)
  if (next.done !== true) expect(next.value.byteLength).toBeGreaterThan(0)
  await stream.return(undefined)
  await rejected
  expect(endpoint.pipe.bufferedBytes).toBe(0)
})
it('preserves pending bytes and rejects the wrong direction', async () => {
  const endpoint = new DevicePipe(true)
  await endpoint.pipe.write(new TextEncoder().encode('abcdef'))
  endpoint.pipe.end()
  expect(new TextDecoder().decode(await endpoint.read(PATH, 2))).toBe('ab')
  let rest = ''
  for await (const chunk of endpoint.stream(PATH)) rest += new TextDecoder().decode(chunk)
  expect(rest).toBe('cdef')
  await expect(endpoint.write(new Uint8Array([1]), PATH)).rejects.toMatchObject({ code: 'EBADF' })
  await expect(new DevicePipe(false).read(PATH)).rejects.toMatchObject({ code: 'EBADF' })
})
it('shares ordinary files but hides descriptors between bound sessions', () => {
  const root = new DevFiles()
  const left = root.forSession('left')
  const right = root.forSession('right')
  const endpoint = new DevicePipe(true)
  const [path, allocation] = left.allocateInput(endpoint)
  expect(left.pipeOf(path.slice(4))).toBe(endpoint)
  expect(right.has(path.slice(4))).toBe(false)
  expect(right.pipeOf(path.slice(4))).toBeNull()
  left.set('/ordinary', new Uint8Array([1]))
  expect(right.get('/ordinary')).toEqual(new Uint8Array([1]))
  expect(left.releaseInput(path, allocation)).toBe(true)
  const [replacement, nextAllocation] = right.allocateInput(new DevicePipe(false))
  expect(replacement).toBe(path)
  expect(left.releaseInput(path, allocation)).toBe(false)
  expect(right.releaseInput(replacement, nextAllocation)).toBe(true)
})
