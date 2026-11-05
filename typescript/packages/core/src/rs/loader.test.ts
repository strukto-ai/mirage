import { afterEach, expect, it, vi } from 'vitest'
import { compiledModule } from './stream.ts'

afterEach(() => {
  vi.doUnmock('#mirage-rs-wasm')
  vi.resetModules()
})

it('defers a lazy module source and shares it across synchronous and asynchronous digests', async () => {
  const module = await compiledModule()
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
    expect(streams.moduleSync()).toBe(module)
  } finally {
    asynchronous.close()
  }
  expect(load).toHaveBeenCalled()
})
