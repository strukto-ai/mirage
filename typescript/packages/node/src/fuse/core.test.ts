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

import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { Workspace } from '../workspace.ts'
import { MountCore } from './core.ts'

async function mkCore(): Promise<MountCore> {
  const ws = new Workspace(
    { '/data/': new RAMResource(), '/extra/': new RAMResource() },
    { mode: MountMode.WRITE },
  )
  await ws.execute("echo 'hello world' | tee /data/greeting.txt")
  await ws.execute("mkdir -p /data/sub && echo 'nested' > /data/sub/inner.txt")
  return new MountCore(ws)
}

describe('MountCore', () => {
  it('reports a file with its real size', async () => {
    const core = await mkCore()
    const attr = await core.getattr('/data/greeting.txt')
    expect(attr.mode & 0o170000).toBe(0o100000)
    expect(attr.size).toBe(12)
  })

  it('reports directories', async () => {
    const core = await mkCore()
    expect((await core.getattr('/data/sub')).mode & 0o170000).toBe(0o040000)
  })

  it('throws a plain error for a missing path, not an errno code', async () => {
    // An adapter classifies the error; the core does not know what a FUSE
    // error code is.
    const core = await mkCore()
    await expect(core.getattr('/data/nope.txt')).rejects.toThrow()
  })

  it('lists children with . and ..', async () => {
    const core = await mkCore()
    const entries = await core.readdir('/data')
    expect(entries.slice(0, 2)).toEqual(['.', '..'])
    expect(entries).toContain('greeting.txt')
    expect(entries).toContain('sub')
  })

  it('slices reads', async () => {
    const core = await mkCore()
    const fh = await core.open('/data/greeting.txt')
    const head = await core.read('/data/greeting.txt', fh, 0, 5)
    expect(new TextDecoder().decode(head)).toBe('hello')
  })

  it('tracks and releases handles', async () => {
    const core = await mkCore()
    const fh = await core.open('/data/greeting.txt')
    expect(core.handles.has(fh)).toBe(true)
    core.release(fh)
    expect(core.handles.has(fh)).toBe(false)
  })

  it('throws EINVAL from readlink on a regular file', async () => {
    const core = await mkCore()
    expect(() => core.readlink('/data/greeting.txt')).toThrow(
      expect.objectContaining({ code: 'EINVAL' }),
    )
  })

  it('signals ENOTEMPTY for a non-empty directory', async () => {
    const core = await mkCore()
    await expect(core.rmdir('/data/sub')).rejects.toThrow(
      expect.objectContaining({ code: 'ENOTEMPTY' }),
    )
  })

  it('round-trips advisory xattrs', async () => {
    const core = await mkCore()
    core.setxattr('/data/greeting.txt', 'user.tag', Buffer.from('v1'))
    expect(core.getxattr('/data/greeting.txt', 'user.tag')?.toString()).toBe('v1')
    expect(core.listxattr('/data/greeting.txt')).toContain('user.tag')
    core.removexattr('/data/greeting.txt', 'user.tag')
    expect(core.listxattr('/data/greeting.txt')).toEqual([])
  })

  it('honors the root prefix when resolving', async () => {
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    const core = new MountCore(ws, { rootPrefix: '/data/' })
    expect(core.resolve('/')).toBe('/data')
    expect(core.resolve('/x.txt')).toBe('/data/x.txt')
  })
})
