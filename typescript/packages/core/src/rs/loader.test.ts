import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compiledModule } from './stream.ts'

afterEach(() => {
  vi.doUnmock('#mirage-rs-wasm')
  vi.resetModules()
})

it('defers a lazy module source and shares it across synchronous and asynchronous digests', async () => {
  const module = compiledModule()
  const load = vi.fn(() => module)
  vi.doMock('#mirage-rs-wasm', () => ({ default: load, AHEAD: false }))
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

// The instance a stream runs on.
function instance(stream: unknown): unknown {
  return (stream as { exports: unknown }).exports
}

it('instantiates nothing synchronously where the loader compiled asynchronously, as a page needs', async () => {
  const module = compiledModule()
  const Instance = WebAssembly.Instance
  WebAssembly.Instance = class extends Instance {
    constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
      if (WebAssembly.Module.exports(module).some((entry) => entry.name === 'mirage_rs_open'))
        throw new RangeError('WebAssembly.Instance is disallowed on the main thread')
      super(module, imports)
    }
  }
  vi.doMock('#mirage-rs-wasm', () => ({ default: module, AHEAD: true }))
  vi.resetModules()
  try {
    const { SessionProfile } = await import('../policy/profile.ts')
    const { StreamModule } = await import('./stream.ts')
    SessionProfile({ paths: { hide: ['/secret'] } })
    const streams = new StreamModule(module)
    await streams.ready()
    const md5 = { algorithm: 'md5' }
    const used = (): unknown => {
      const stream = streams.openSync('digest', md5, false)
      stream.close()
      return instance(stream)
    }
    const first = used()
    streams.retire(first as never, false)
    const second = used()
    expect(second).not.toBe(first)
    // Retired again before another is made: it stays.
    streams.retire(second as never, false)
    expect(used()).toBe(second)
    await streams.ready()
    streams.retire(second as never, false)
    expect(used()).not.toBe(second)
  } finally {
    WebAssembly.Instance = Instance
  }
})

describe('the browser loader', () => {
  const loader = new URL('../../dist/generated/mirage_gh.js', import.meta.url).href
  const bytes = new Uint8Array(
    readFileSync(new URL('../../dist/generated/mirage_gh.wasm', import.meta.url)),
  )
  let round = 0
  const load = async (response: Response): Promise<WebAssembly.Module> => {
    vi.stubGlobal('fetch', () => Promise.resolve(response))
    try {
      round += 1
      const loaded = (await import(/* @vite-ignore */ `${loader}?${String(round)}`)) as {
        default: WebAssembly.Module
      }
      return loaded.default
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it('compiles a module served as application/wasm while it downloads', async () => {
    const response = new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } })
    expect(await load(response)).toBeInstanceOf(WebAssembly.Module)
  })

  it('compiles a module served under another type', async () => {
    const response = new Response(bytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    expect(await load(response)).toBeInstanceOf(WebAssembly.Module)
  })

  it('names the URL and the fix when the answer is not WebAssembly', async () => {
    const response = new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })
    await expect(load(response)).rejects.toThrow(
      /mirage_gh\.wasm answered 200 text\/html, not WebAssembly: .* under pnpm add @struktoai\/mirage-core/,
    )
  })
})
