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
import type { BridgeDispatchFn } from '../../types.ts'
import { RuntimeVFS } from '../../vfs.ts'
import { MirageOSAccess } from './index.ts'
import { MontyVFS } from './vfs.ts'
import { PrefixResolver } from '../../resolver.ts'

const NOT_HANDLED = Symbol('NOT_HANDLED')

function accessOn(
  dispatch: BridgeDispatchFn,
  env: Record<string, string> = {},
  mounts: string[] = ['/ram'],
): MirageOSAccess {
  return new MirageOSAccess(
    NOT_HANDLED,
    env,
    new MontyVFS(new RuntimeVFS(dispatch, new PrefixResolver(() => mounts))),
  )
}

const noop = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))

describe('MirageOSAccess environment', () => {
  it('answers os.getenv from the run environment, with the caller default on a miss', () => {
    const access = accessOn(noop, { HOME: '/root' })
    expect(access.handle('os.getenv', ['HOME'])).toBe('/root')
    expect(access.handle('os.getenv', ['NOPE'])).toBeNull()
    expect(access.handle('os.getenv', ['NOPE', 'fallback'])).toBe('fallback')
  })

  it('misses on an inherited property rather than leaking a host function', () => {
    // The guest picks the key, so `toString` must not resolve.
    expect(accessOn(noop, {}).handle('os.getenv', ['toString'])).toBeNull()
  })

  it('hands os.environ a copy, so a mutating guest cannot reach the session env', () => {
    const env = { A: '1' }
    const out = accessOn(noop, env).handle('os.environ', []) as Record<string, string>
    expect(out).toEqual({ A: '1' })
    out.A = 'tampered'
    expect(env.A).toBe('1')
  })

  it('answers the environment doors even with no workspace attached', () => {
    const access = new MirageOSAccess(NOT_HANDLED, { A: '1' }, null)
    expect(access.handle('os.getenv', ['A'])).toBe('1')
    expect(access.handle('Path.read_text', ['/ram/x'])).toBe(NOT_HANDLED)
  })
})

describe('MirageOSAccess declining', () => {
  it('declines a path outside every mount, so monty serves it from its own tree', () => {
    expect(accessOn(noop).handle('Path.read_bytes', ['/tmp/x'])).toBe(NOT_HANDLED)
  })

  it('declines an operation it does not implement', () => {
    expect(accessOn(noop).handle('Path.chmod', ['/ram/x'])).toBe(NOT_HANDLED)
  })

  it('declines a rename whose destination is outside the workspace', () => {
    // Declining beats half-applying: monty then moves it in its own tree.
    expect(accessOn(noop).handle('Path.rename', ['/ram/x', '/tmp/y'])).toBe(NOT_HANDLED)
  })

  it('accepts a path object as well as a string', () => {
    expect(accessOn(noop).handle('Path.mkdir', [{ path: '/ram/d' }])).not.toBe(NOT_HANDLED)
  })
})

describe('MirageOSAccess path operations', () => {
  it('decodes read_text and leaves read_bytes raw', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(new TextEncoder().encode('hi')))
    const access = accessOn(dispatch)
    expect(await access.handle('Path.read_text', ['/ram/x'])).toBe('hi')
    expect(await access.handle('Path.read_bytes', ['/ram/x'])).toEqual(
      new TextEncoder().encode('hi'),
    )
  })

  it('iterdir yields the entry paths', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve([
        { path: '/ram/d/a', size: 1, isDir: false },
        { path: '/ram/d/sub', size: 0, isDir: true },
      ]),
    )
    expect(await accessOn(dispatch).handle('Path.iterdir', ['/ram/d'])).toEqual([
      '/ram/d/a',
      '/ram/d/sub',
    ])
  })

  it('answers the exists family as booleans, never as a rejection', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/d/') {
        return Promise.resolve([{ path: '/ram/d/a', size: 1, isDir: false }])
      }
      return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    })
    const access = accessOn(dispatch)
    expect(await access.handle('Path.is_dir', ['/ram/d'])).toBe(true)
    expect(await access.handle('Path.is_file', ['/ram/d/a'])).toBe(true)
    expect(await access.handle('Path.exists', ['/ram/d/a'])).toBe(true)
    expect(await access.handle('Path.is_file', ['/ram/d/nope'])).toBe(false)
    expect(await access.handle('Path.exists', ['/ram/nope/deep'])).toBe(false)
  })
})
