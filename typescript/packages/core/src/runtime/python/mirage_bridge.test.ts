// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it, vi } from 'vitest'
import { createMirageBridge, preloadInto } from './mirage_bridge.ts'
import type { BridgeDispatchFn } from '../types.ts'

describe('createMirageBridge', () => {
  it('forwards fetch to dispatch READ and returns bytes', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(new Uint8Array([1, 2, 3])))
    const b = createMirageBridge(dispatch)
    const out = await b.fetch('/ram/x.txt')
    expect(dispatch).toHaveBeenCalledWith('READ', '/ram/x.txt')
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it('forwards flush to dispatch WRITE with bytes and resolves void', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    const b = createMirageBridge(dispatch)
    await b.flush('/ram/x.txt', new Uint8Array([9, 9]))
    const call = dispatch.mock.calls[0]
    if (call === undefined) throw new Error('unreachable')
    const [op, path, bytes] = call
    if (bytes === undefined) throw new Error('unreachable')
    expect(op).toBe('WRITE')
    expect(path).toBe('/ram/x.txt')
    expect(Array.from(bytes)).toEqual([9, 9])
  })

  it('forwards list to dispatch LIST and returns entries', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve([
        { path: '/ram/a.txt', size: 4, isDir: false },
        { path: '/ram/sub', size: 0, isDir: true },
      ]),
    )
    const b = createMirageBridge(dispatch)
    const entries = await b.list('/ram/')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ path: '/ram/a.txt', size: 4, isDir: false })
  })

  it('rethrows dispatch errors', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.reject(new Error('boom')))
    const b = createMirageBridge(dispatch)
    await expect(b.fetch('/x')).rejects.toThrow(/boom/)
  })

  it('throws TypeError when READ returns non-Uint8Array', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve('not bytes' as unknown as Uint8Array),
    )
    await expect(createMirageBridge(dispatch).fetch('/x')).rejects.toThrow(TypeError)
  })

  it('throws TypeError when LIST returns non-array', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve({ not: 'array' } as unknown as never[]),
    )
    await expect(createMirageBridge(dispatch).list('/x')).rejects.toThrow(TypeError)
  })

  it('throws TypeError when LIST entry has bad shape', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve([{ path: '/x' }] as unknown as never[]),
    )
    await expect(createMirageBridge(dispatch).list('/x')).rejects.toThrow(TypeError)
  })

  it('throws TypeError when WRITE dispatch returns non-undefined', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve('unexpected' as unknown))
    await expect(createMirageBridge(dispatch).flush('/x', new Uint8Array([1]))).rejects.toThrow(
      TypeError,
    )
  })
})

interface FakeFS {
  mkdirTree(path: string): void
  writeFile(path: string, bytes: Uint8Array): void
  _dirs: Set<string>
  _files: Map<string, Uint8Array>
}

function makeFakeFS(): FakeFS {
  const dirs = new Set<string>()
  const files = new Map<string, Uint8Array>()
  return {
    _dirs: dirs,
    _files: files,
    mkdirTree(path) {
      dirs.add(path)
    },
    writeFile(path, bytes) {
      files.set(path, bytes)
    },
  }
}

describe('preloadInto', () => {
  it('creates the prefix directory and writes flat files', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'LIST' && path === '/ram/') {
        return Promise.resolve([
          { path: '/ram/a.txt', size: 5, isDir: false },
          { path: '/ram/b.bin', size: 3, isDir: false },
        ])
      }
      if (op === 'READ' && path === '/ram/a.txt')
        return Promise.resolve(new TextEncoder().encode('hello'))
      if (op === 'READ' && path === '/ram/b.bin') return Promise.resolve(new Uint8Array([1, 2, 3]))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, createMirageBridge(dispatch), '/ram/')
    expect(fs._dirs.has('/ram')).toBe(true)
    expect(new TextDecoder().decode(fs._files.get('/ram/a.txt'))).toBe('hello')
    const bbin = fs._files.get('/ram/b.bin')
    if (bbin === undefined) throw new Error('unreachable')
    expect(Array.from(bbin)).toEqual([1, 2, 3])
  })

  it('recurses into subdirectories', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'LIST' && path === '/ram/')
        return Promise.resolve([{ path: '/ram/sub', size: 0, isDir: true }])
      if (op === 'LIST' && path === '/ram/sub/')
        return Promise.resolve([{ path: '/ram/sub/c.txt', size: 1, isDir: false }])
      if (op === 'READ' && path === '/ram/sub/c.txt') return Promise.resolve(new Uint8Array([7]))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, createMirageBridge(dispatch), '/ram/')
    expect(fs._dirs.has('/ram/sub')).toBe(true)
    const ctxt = fs._files.get('/ram/sub/c.txt')
    if (ctxt === undefined) throw new Error('unreachable')
    expect(Array.from(ctxt)).toEqual([7])
  })

  it('is idempotent: re-running overwrites with the bridge content', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'LIST' && path === '/ram/')
        return Promise.resolve([{ path: '/ram/x', size: 1, isDir: false }])
      if (op === 'READ' && path === '/ram/x') return Promise.resolve(new Uint8Array([42]))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    const bridge = createMirageBridge(dispatch)
    await preloadInto(fs, bridge, '/ram/')
    fs.writeFile('/ram/x', new Uint8Array([99]))
    await preloadInto(fs, bridge, '/ram/')
    const x = fs._files.get('/ram/x')
    if (x === undefined) throw new Error('unreachable')
    expect(Array.from(x)).toEqual([42])
  })

  it('handles empty mounts (LIST returns [])', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) =>
      Promise.resolve(op === 'LIST' ? [] : new Uint8Array()),
    )
    const fs = makeFakeFS()
    await preloadInto(fs, createMirageBridge(dispatch), '/ram/')
    expect(fs._dirs.has('/ram')).toBe(true)
    expect(fs._files.size).toBe(0)
  })

  it('accepts a prefix without trailing slash and lists with one', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'LIST' && path === '/ram/') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, createMirageBridge(dispatch), '/ram')
    expect(fs._dirs.has('/ram')).toBe(true)
    expect(dispatch).toHaveBeenCalledWith('LIST', '/ram/')
  })

  it('skips a single failing entry and still preloads the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'LIST' && path === '/ram/') {
        return Promise.resolve([
          { path: '/ram/ok.txt', size: 2, isDir: false },
          { path: '/ram/bad.txt', size: 4, isDir: false },
        ])
      }
      if (op === 'READ' && path === '/ram/ok.txt') return Promise.resolve(new Uint8Array([1, 2]))
      if (op === 'READ' && path === '/ram/bad.txt') return Promise.reject(new Error('unreadable'))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, createMirageBridge(dispatch), '/ram/')
    const ok = fs._files.get('/ram/ok.txt')
    if (ok === undefined) throw new Error('unreachable')
    expect(Array.from(ok)).toEqual([1, 2])
    expect(fs._files.has('/ram/bad.txt')).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('skips a failing subtree and still preloads sibling files', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'LIST' && path === '/ram/') {
        return Promise.resolve([
          { path: '/ram/ok.txt', size: 1, isDir: false },
          { path: '/ram/bad', size: 0, isDir: true },
        ])
      }
      if (op === 'READ' && path === '/ram/ok.txt') return Promise.resolve(new Uint8Array([7]))
      if (op === 'LIST' && path === '/ram/bad/') return Promise.reject(new Error('subtree fail'))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, createMirageBridge(dispatch), '/ram/')
    const ok = fs._files.get('/ram/ok.txt')
    if (ok === undefined) throw new Error('unreachable')
    expect(Array.from(ok)).toEqual([7])
    expect(fs._dirs.has('/ram/bad')).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('lets the top-level LIST error propagate', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.reject(new Error('top-level boom')))
    const fs = makeFakeFS()
    await expect(preloadInto(fs, createMirageBridge(dispatch), '/ram/')).rejects.toThrow(
      /top-level boom/,
    )
  })
})
