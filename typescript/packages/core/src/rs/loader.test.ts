import { afterEach, expect, it, vi } from 'vitest'
import { compiledModule } from './stream.ts'

afterEach(() => {
  vi.doUnmock('#mirage-rs-wasm')
  vi.resetModules()
})

it('defers a lazy module source and shares it across synchronous and asynchronous digests', async () => {
  const module = compiledModule()
  const load = vi.fn(() => module)
  vi.doMock('#mirage-rs-wasm', () => ({ default: load }))
  vi.resetModules()
  const streams = await import('./stream.ts')
  expect(load).not.toHaveBeenCalled()
  const synchronous = streams.openStreamSync('digest', { algorithm: 'md5' })
  try {
    expect(new TextDecoder().decode(synchronous.finish())).toBe('d41d8cd98f00b204e9800998ecf8427e')
  } finally {
    synchronous.close()
  }
  const asynchronous = await streams.openStream('digest', { algorithm: 'sha1' })
  try {
    asynchronous.feed(new TextEncoder().encode('abc'))
    expect(new TextDecoder().decode(asynchronous.finish())).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    )
    expect(streams.compiledModule()).toBe(module)
  } finally {
    asynchronous.close()
  }
  expect(load).toHaveBeenCalled()
})

it('instantiates nothing synchronously once ready, as a page, whose main thread refuses a module over 8 MB, needs', async () => {
  const Instance = WebAssembly.Instance
  WebAssembly.Instance = class extends Instance {
    constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
      if (WebAssembly.Module.exports(module).some((entry) => entry.name === 'mirage_rs_open'))
        throw new RangeError('WebAssembly.Instance is disallowed on the main thread')
      super(module, imports)
    }
  }
  vi.resetModules()
  try {
    const { SessionProfile } = await import('../policy/profile.ts')
    const { PosixRegex } = await import('./regex.ts')
    const streams = await import('./stream.ts')
    await streams.streamsReady()
    SessionProfile({ paths: { hide: ['/secret'] } })
    const regex = new PosixRegex('x$')
    const size = 34 * 1024 * 1024
    const md5 = { algorithm: 'md5' }
    for (let round = 0; round < 2; round += 1) {
      expect(await regex.search('a'.repeat(size) + 'x')).toEqual([[size, size + 1]])
      // Only the matcher is left on the grown instance, so it retires.
      streams.openStreamSync('digest', md5).close()
      streams.openStreamSync('digest', md5).close()
      await streams.streamsReady()
    }
  } finally {
    WebAssembly.Instance = Instance
  }
})
