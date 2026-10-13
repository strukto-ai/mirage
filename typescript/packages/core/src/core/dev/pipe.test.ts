import { expect, it } from 'vitest'
import { DevicePipe } from './pipe.ts'
import { CAPACITY } from '../../io/pipe.ts'
import { PipeClosed } from '../../io/errors.ts'
import { MountMode, PathSpec } from '../../types.ts'
import type { DevVFS } from '../../vfs/dev/dev.ts'
import { DevFiles } from '../../vfs/dev/store.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'

const PATH = PathSpec.fromStrPath('/dev/fd/63')
const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function drain(endpoint: DevicePipe, seen: string[]): Promise<void> {
  for await (const chunk of endpoint.stream(PATH)) seen.push(DEC.decode(chunk))
}

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
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(endpoint.pipe.closedReader).toBe(false)
  expect(done).toBe(false)
  endpoint.pipe.closeReader()
  await rejected
  expect(endpoint.pipe.bufferedBytes).toBe(0)
})

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

it.each([
  ['f() { cat "$1" & cat "$1"; wait; }; f <(sleep 0.2; printf data)', 'data'],
  ['f() { head -c 1 "$1"; echo; cat "$1"; }; f <(printf a; sleep 0.2; printf rest)', 'a\nrest'],
  ['f() { cat "$1"; cat "$1"; }; f <(printf once)', 'once'],
])('function readers share one substitution: %s', async (command, expected) => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const io = await ws.shell(command)
    expect([io.exitCode, io.stdoutText, io.stderrText]).toEqual([0, expected, ''])
    const [dev] = ws.registry.resolve('/dev/null')
    expect(((dev as DevVFS).store.files as DevFiles).state.inputs.size).toBe(0)
  } finally {
    await ws.close()
  }
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
