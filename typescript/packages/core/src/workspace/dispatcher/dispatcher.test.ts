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

import { yieldBytes } from '../../io/stream.ts'

import { type CallerDispatchFn, currentCaller } from '../../context/session_context.ts'
import type { EntryGate } from '../../policy/types.ts'
import { ALL_COMMANDS } from '../../policy/builtin/output_cap.ts'
import { Command } from '../../commands/config.ts'
import type { IOResult } from '../../io/types.ts'
import { describe, expect, it, vi } from 'vitest'
import { materialize, OpReport, type ByteSource } from '../../io/types.ts'
import { runWithSession } from '../../context/session_context.ts'
import { record, revisionFor, runWithRecording, startOp } from '../../observe/context.ts'
import { MountEntry } from '../mount/mount.ts'
import { BatchedRAM, dispatched, render } from '../../test-utils.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { POLICY_WRITE_OPS, READ_AHEAD_BYTES } from './constants.ts'
import { runInCommandScope } from '../../cache/index/scope.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { BaseVFS } from '../../vfs/base.ts'
import type { Handed } from '../../vfs/types.ts'
import { eacces, enoent, erofs, exdev } from '../../errors/fs.ts'
import type { Policy } from '../../policy/base.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { Action, VfsContext, VfsResultContext } from '../../policy/types.ts'
import { followedDay } from '../../core/time_range.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { sliceWindow, spliceWindow } from '../../utils/ranges.ts'
import { ident } from '../../utils/stat_view.ts'
import { stripSlash } from '../../utils/slash.ts'
import {
  DirListing,
  FileStat,
  FileType,
  Limit,
  MountMode,
  OnExceed,
  PathSpec,
} from '../../types.ts'
import { SessionState } from '../session/session.ts'
import { Workspace } from '../workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe('dispatch applies limits on the executing mount', () => {
  it('a mount read entry cuts nothing, through a link either', async () => {
    const data = new RAMVFS()
    const plain = new RAMVFS()
    const ws = new Workspace(
      {
        '/data': [data, MountMode.EXEC, { read: new Limit({ maxBytes: 8 }) }],
        '/r': plain,
      },
      { mode: MountMode.EXEC },
    )
    try {
      await ws.shell('echo 0123456789abcdef > /data/big.txt')
      await ws.shell('ln -s /data/big.txt /r/link')
      const direct = (await ws.dispatch('read', '/data/big.txt')) as Uint8Array
      const viaLink = (await ws.dispatch('read', '/r/link')) as Uint8Array
      expect(DEC.decode(direct)).toBe('0123456789abcdef\n')
      expect(DEC.decode(viaLink)).toBe(DEC.decode(direct))
    } finally {
      await ws.close()
    }
  }, 30_000)

  it.each([
    [false, OnExceed.TRUNCATE],
    [true, OnExceed.TRUNCATE],
    [false, OnExceed.ERROR],
    [true, OnExceed.ERROR],
  ])('a mount read entry never cuts a file call (warm %s, %s)', async (warm, onExceed) => {
    const data = ENC.encode(
      Array.from({ length: 200 }, (_, i) => `line ${String(i + 1)}\n`).join(''),
    )
    const ram = new RAMVFS()
    Object.assign(ram, { cachesReads: warm })
    const ws = new Workspace(
      {
        '/data': [
          ram,
          MountMode.WRITE,
          { read: new Limit({ maxLines: 3, maxBytes: 5, onExceed }) },
        ],
      },
      { mode: MountMode.WRITE },
    )
    try {
      await ws.vfs.write('/data/f.txt', data)
      if (warm) await ws.cache.set('/data/f.txt', data, { ttl: 600 })
      expect(DEC.decode(await ws.vfs.read('/data/f.txt'))).toBe(DEC.decode(data))
      const window = await ws.vfs.read('/data/f.txt', { offset: 100, size: 200 })
      expect(DEC.decode(window)).toBe(DEC.decode(data.subarray(100, 300)))
      const tail = await ws.vfs.read('/data/f.txt', { offset: 100 })
      expect(DEC.decode(tail)).toBe(DEC.decode(data.subarray(100)))
      const streamed = await pullAll(await ws.vfs.read('/data/f.txt', { stream: true }))
      expect(streamed.join('')).toBe(DEC.decode(data))
    } finally {
      await ws.close()
    }
  })
})

describe('dispatch rename across mounts', () => {
  it.each([
    ['/nope/y.txt', 'ENOENT'],
    ['/b/f/y.txt', 'ENOTDIR'],
    ['/x/y.txt', 'EXDEV'],
  ])(
    'resolves the parent of %s first: %s',
    async (dst, code) => {
      // Mirrors Python's test_dispatch_rename_across_mounts_resolves_the_parent_first.
      // rename(2) resolves the destination's directory before it compares
      // filesystems: a missing one is ENOENT and one through a file ENOTDIR;
      // /x, which the namespace holds above the /x/m mount, is there, so the
      // answer is EXDEV.
      const ws = new Workspace(
        { '/a': new RAMVFS(), '/b': new RAMVFS(), '/x/m': new RAMVFS() },
        { mode: MountMode.EXEC },
      )
      try {
        await ws.shell('echo moved-bytes > /a/x.txt; echo f > /b/f')
        await expect(
          ws.dispatch('rename', '/a/x.txt', [PathSpec.fromStrPath(dst)]),
        ).rejects.toMatchObject({ code })
        expect(DEC.decode((await ws.shell('cat /a/x.txt')).stdout)).toBe('moved-bytes\n')
      } finally {
        await ws.close()
      }
    },
    30_000,
  )

  it.each(['/a/x.txt', '/a/missing.txt'])(
    'answers EXDEV and moves nothing: %s',
    async (src) => {
      // Mirrors Python's test_dispatch_rename_across_mounts_is_exdev. A mount
      // is a filesystem boundary, so rename(2) answers EXDEV across two before
      // it looks the source up, and nothing moves: the source's backend never
      // takes '/b/y.txt' for one of its own keys.
      const ws = new Workspace({ '/a': new RAMVFS(), '/b': new RAMVFS() }, { mode: MountMode.EXEC })
      try {
        await ws.shell('echo moved-bytes > /a/x.txt')
        await expect(
          ws.dispatch('rename', src, [PathSpec.fromStrPath('/b/y.txt')]),
        ).rejects.toMatchObject({ code: 'EXDEV' })
        expect(DEC.decode((await ws.shell('cat /a/x.txt')).stdout)).toBe('moved-bytes\n')
        expect((await ws.shell('cat /a/b/y.txt')).exitCode).not.toBe(0)
        expect((await ws.shell('cat /b/y.txt')).exitCode).not.toBe(0)
      } finally {
        await ws.close()
      }
    },
    30_000,
  )
})

describe('dispatch resolves a rendered filetype by path extension', () => {
  it('the renderer of a filetype wins over the plain read', async () => {
    // gdocs/gsheets/gslides render their reads under a compound filetype.
    // Every dispatch-based path (crossmount relay, FUSE) reaches the
    // renderer by the path's extension, as the shell does.
    class DocRAM extends RAMVFS {
      override readonly renderers: Readonly<Record<string, string>> = {
        '.gdoc.json': 'readDoc',
      }

      readDoc(): Promise<Uint8Array> {
        return Promise.resolve(ENC.encode('rendered'))
      }
    }
    const ram = new DocRAM()
    const ws = new Workspace({ '/m': ram }, { mode: MountMode.EXEC })
    try {
      await ws.shell('echo raw > /m/doc.gdoc.json')
      const bytes = (await ws.dispatch('read', '/m/doc.gdoc.json')) as Uint8Array
      expect(DEC.decode(bytes)).toBe('rendered')
    } finally {
      await ws.close()
    }
  }, 30_000)
})

it('names the path the op ran on in its report', async () => {
  // A record names the file a link led to, read off the report rather than
  // from a second follow of the link.
  const ws = new Workspace({ '/ram': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    await ws.shell('echo body > /ram/a.txt; ln -s a.txt /ram/lk')
    const report = new OpReport()
    const { dispatcher } = ws as unknown as { dispatcher: { dispatch: DispatchFn } }
    await dispatcher.dispatch('read', PathSpec.fromStrPath('/ram/lk'), [], {}, report)
    expect(report.path).toBe('/ram/a.txt')
  } finally {
    await ws.close()
  }
})

it.each([
  [null, 'new'],
  [2, null],
])('keeps what a streamed write sent within drain budget %s', async (budget, kept) => {
  const destination = new StreamWritingRAM()
  const ws = new Workspace({ '/dst': destination }, { mode: MountMode.WRITE })
  ws.cache.maxDrainBytes = budget
  const tokens: (string | null)[] = []
  const original = destination.write.bind(destination)
  vi.spyOn(destination, 'write').mockImplementation(async (path, data) => {
    if (data instanceof Uint8Array) return original(path, data)
    tokens.push((await ws.cache.fingerprints([path.virtual]))[0] ?? null)
    expect(await ws.cache.exists(path.virtual)).toBe(false)
    await original(path, data)
    record('write', path.virtual, destination.name, 3, startOp(), { fingerprint: 'v2' })
  })
  try {
    await ws.vfs.write('/dst/f', 'old')
    await ws.cache.set('/dst/f', new TextEncoder().encode('old'), { fingerprint: 'v1' })
    const reused = async function* (): AsyncIterable<Uint8Array> {
      const buffer = new Uint8Array(1)
      for (const byte of new TextEncoder().encode('new')) {
        await Promise.resolve()
        buffer[0] = byte
        yield buffer
      }
    }
    await ws.vfs.write('/dst/f', reused())
    expect(tokens).toEqual(['v1'])
    const cached = await ws.cache.get('/dst/f')
    expect(cached === null ? null : new TextDecoder().decode(cached)).toBe(kept)
    expect((await ws.cache.fingerprints(['/dst/f']))[0]).toBe('v2')
  } finally {
    await ws.close()
  }
})

it('keeps no copy from before an empty streamed append waited', async () => {
  const ws = new Workspace({ '/dst': new StreamWritingRAM() }, { mode: MountMode.WRITE })
  let asked = (): void => undefined
  let done = (): void => undefined
  const waiting = new Promise<void>((resolve) => (asked = resolve))
  const ended = new Promise<void>((resolve) => (done = resolve))
  const quiet: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      asked()
      await ended
      return { done: true, value: undefined }
    },
  }
  try {
    await ws.vfs.write('/dst/f', 'old')
    await ws.cache.set('/dst/f', new TextEncoder().encode('old'), { fingerprint: 'v1' })
    const pending = ws.vfs.append('/dst/f', quiet)
    await waiting
    await ws.vfs.append('/dst/f', new TextEncoder().encode('new'))
    done()
    await pending
    const cached = await ws.cache.get('/dst/f')
    expect(cached === null ? null : new TextDecoder().decode(cached)).not.toBe('old')
    expect(DEC.decode(await ws.vfs.read('/dst/f'))).toBe('oldnew')
  } finally {
    await ws.close()
  }
})

it.each([
  [MountMode.READ, undefined, { code: 'EROFS' }],
  [MountMode.WRITE, 'missing', { message: 'unknown session: missing' }],
])('closes a refused upload without pulling it (%s, %s)', async (mode, sessionId, refusal) => {
  const ws = new Workspace({ '/dst': new RAMVFS() }, { mode })
  let closed = false
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      return Promise.reject(new Error('a refused write pulled its input'))
    },
    return() {
      closed = true
      return Promise.resolve({ done: true, value: undefined })
    },
  }
  try {
    await expect(ws.vfs.write('/dst/f', source, sessionId)).rejects.toMatchObject(refusal)
    expect(closed).toBe(true)
  } finally {
    await ws.close()
  }
})

it('records the bytes a streamed write sent', async () => {
  const ws = new Workspace({ '/dst': new StreamWritingRAM() }, { mode: MountMode.WRITE })
  try {
    await ws.vfs.write('/dst/f', yieldBytes(new TextEncoder().encode('new')))
    await ws.vfs.append('/dst/f', yieldBytes(new TextEncoder().encode('tail')))
    expect(
      ws.vfs.records
        .filter((r) => r.op === 'write' || r.op === 'append')
        .map((r) => [r.op, r.bytes]),
    ).toEqual([
      ['write', 3],
      ['append', 4],
    ])
  } finally {
    await ws.close()
  }
})

class StreamWritingRAM extends RAMVFS {
  override readonly cachesReads = true
  readonly streamed: [string, string][] = []
  readonly chunkSizes: number[] = []
  fail = false

  override async write(path: PathSpec, data: ByteSource): Promise<void> {
    if (data instanceof Uint8Array) return super.write(path, data)
    this.streamed.push(['write', path.virtual])
    const content: Uint8Array[] = []
    for await (const chunk of data as AsyncIterable<Uint8Array>) {
      this.chunkSizes.push(chunk.length)
      if (this.fail) {
        await super.write(path, chunk)
        throw Object.assign(new Error('write failed after a prefix'), { code: 'EIO' })
      }
      content.push(chunk.slice())
    }
    const combined = new Uint8Array(content.reduce((size, chunk) => size + chunk.length, 0))
    let offset = 0
    for (const chunk of content) {
      combined.set(chunk, offset)
      offset += chunk.length
    }
    await super.write(path, combined)
  }

  override async append(path: PathSpec, data: ByteSource): Promise<void> {
    if (data instanceof Uint8Array) return super.append(path, data)
    this.streamed.push(['append', path.virtual])
    await super.append(path, await materialize(data))
  }
}

describe('native streamed writes', () => {
  it.each([
    ['cat /src/f > /dst/out', '/dst/out', 'a\nb\nc'],
    ['cat /src/f >> /dst/out', '/dst/out', 'a\nb\nc'],
    ['cat /src/f | tee /dst/out', '/dst/out', 'a\nb\nc'],
    ['cp /src/f /dst/out', '/dst/out', 'a\nb\nc'],
    ['split -l 2 /src/f /dst/part', '/dst/partab', 'c'],
    ["sed -n 'w /dst/out' /src/f", '/dst/out', 'a\nb\nc'],
    [`awk '{ print > "/dst/out" }' /src/f`, '/dst/out', 'a\nb\nc\n'],
    ['sort -o /dst/out /src/f', '/dst/out', 'a\nb\nc\n'],
    ['xxd -p /src/f /dst/out', '/dst/out', '610a620a63\n'],
    ['sed -i s/a/A/ /dst/edit', '/dst/edit', 'A\nb\nc'],
  ])('streams %s', async (line, target, expected) => {
    const destination = new StreamWritingRAM()
    const ws = new Workspace(
      { '/src': new RAMVFS(), '/dst': destination },
      { mode: MountMode.WRITE },
    )
    try {
      await ws.vfs.write('/src/f', 'a\nb\nc')
      await ws.vfs.write('/dst/edit', 'a\nb\nc')
      const result = await ws.shell(line)
      expect(result.exitCode, DEC.decode(await materialize(result.stderr))).toBe(0)
      expect(destination.streamed.some(([, path]) => path === target)).toBe(true)
      expect(DEC.decode(await ws.vfs.read(target))).toBe(expected)
      expect(Math.max(0, ...destination.chunkSizes)).toBeLessThanOrEqual(16384)
    } finally {
      await ws.close()
    }
  })

  it.each([
    ['cat /dst/f >> /dst/f', { '/dst/f': 'a\nb\nca\nb\nc' }],
    ["sed -n -e 'w /dst/a' -e 'w /dst/b' /dst/f", { '/dst/a': 'a\nb\nc', '/dst/b': 'a\nb\nc' }],
  ])('never rereads or reopens its output: %s', async (line, expected) => {
    const destination = new StreamWritingRAM()
    const ws = new Workspace({ '/dst': destination }, { mode: MountMode.WRITE })
    try {
      await ws.vfs.write('/dst/f', 'a\nb\nc')
      const result = await ws.shell(line)
      expect(result.exitCode, DEC.decode(await materialize(result.stderr))).toBe(0)
      for (const [path, data] of Object.entries(expected))
        expect(DEC.decode(await ws.vfs.read(path))).toBe(data)
      const streamed = destination.streamed.map(([, path]) => path)
      expect(streamed).not.toContain('/dst/f')
      for (const path of Object.keys(expected))
        expect(streamed.filter((p) => p === path).length).toBeLessThanOrEqual(1)
    } finally {
      await ws.close()
    }
  })

  it('invalidates a failed write and closes its input', async () => {
    const destination = new StreamWritingRAM()
    const ws = new Workspace({ '/dst': destination }, { mode: MountMode.WRITE })
    let closed = false
    try {
      await ws.vfs.write('/dst/f', 'old')
      expect(DEC.decode(await ws.vfs.read('/dst/f'))).toBe('old')
      destination.fail = true
      async function* source(): AsyncGenerator<Uint8Array> {
        await Promise.resolve()
        try {
          yield new TextEncoder().encode('new')
          yield new TextEncoder().encode('tail')
        } finally {
          closed = true
        }
      }
      await expect(ws.vfs.write('/dst/f', source())).rejects.toThrow('write failed')
      expect(closed).toBe(true)
      expect(await ws.cache.exists('/dst/f')).toBe(false)
      expect(DEC.decode(await ws.vfs.read('/dst/f'))).toBe('new')
    } finally {
      await ws.close()
    }
  })
})

describe('unlink of a namespace link', () => {
  it('removes the link, which no backend can see', async () => {
    // The dispatcher creates links (`symlink`), so it has to remove them too: a
    // link has no backend entry, so forwarding the unlink reaches a backend
    // that has never heard of the name and answers ENOENT, leaving the link
    // in place. That is what left `git checkout` unable to drop a link the
    // other branch does not have.
    const ram = new RAMVFS()
    const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE })
    try {
      await ws.shell('echo hi > /ram/a.txt')
      await ws.shell('ln -s a.txt /ram/link')
      await ws.dispatch('unlink', '/ram/link')
      const listing = await ws.shell('ls /ram')
      expect(DEC.decode(listing.stdout)).not.toContain('link')
    } finally {
      await ws.close()
    }
  })

  it('still reaches the backend for an ordinary file', async () => {
    const ram = new RAMVFS()
    const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE })
    try {
      await ws.shell('echo hi > /ram/a.txt')
      await ws.dispatch('unlink', '/ram/a.txt')
      const listing = await ws.shell('ls /ram')
      expect(DEC.decode(listing.stdout).trim()).toBe('')
    } finally {
      await ws.close()
    }
  })
})

describe('the node table answers every verb that names a link', () => {
  async function linkWorkspace(): Promise<Workspace> {
    const ram = new RAMVFS()
    const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE })
    await ws.shell('echo hi > /ram/a.txt')
    await ws.shell('mkdir /ram/d')
    await ws.shell('ln -s a.txt /ram/link')
    return ws
  }

  it('renames the link, which no backend can see', async () => {
    // Same fact as the unlink above, one verb along: a guest's rename of
    // a link forwarded to a backend that had never heard of the name, so
    // it answered ENOENT with the link still under the old one.
    const ws = await linkWorkspace()
    try {
      await ws.dispatch('rename', '/ram/link', [PathSpec.fromStrPath('/ram/moved')])
      expect(DEC.decode((await ws.shell('readlink /ram/moved')).stdout)).toBe('a.txt\n')
      expect((await ws.shell('readlink /ram/link')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('carries the nodes below a renamed directory', async () => {
    // A rename re-anchors a whole subtree, and the part of it no backend can
    // see has to move with it: the link below the source used to stay at a
    // name the rename had emptied, so the moved directory was missing it and
    // the old name still answered readlink.
    const ws = await linkWorkspace()
    try {
      await ws.shell('echo hi > /ram/d/a.txt')
      await ws.shell('ln -s a.txt /ram/d/inner')
      await ws.dispatch('rename', '/ram/d', [PathSpec.fromStrPath('/ram/e')])
      expect(DEC.decode((await ws.shell('readlink /ram/e/inner')).stdout)).toBe('a.txt\n')
      expect((await ws.shell('readlink /ram/d/inner')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('refuses a rename destination holding a link', async () => {
    // A link is a directory entry no backend can see, so a destination the
    // backend reads as empty is not: POSIX rename(2) answers ENOTEMPTY for it
    // (probed on debian:stable-slim, where a directory holding one broken
    // symlink refuses the rename). Letting the backend decide replaced the
    // directory and deleted the link with it, which loses namespace state
    // where the kernel refuses.
    const ws = await linkWorkspace()
    try {
      await ws.shell('echo hi > /ram/d/a.txt')
      await ws.shell('ln -s a.txt /ram/d/inner')
      await ws.shell('mkdir /ram/e')
      await ws.shell('ln -s gone /ram/e/stale')
      await expect(
        ws.dispatch('rename', '/ram/d', [PathSpec.fromStrPath('/ram/e')]),
      ).rejects.toMatchObject({ code: 'ENOTEMPTY' })
      // Nothing moved: both ends are as they were.
      expect(DEC.decode((await ws.shell('readlink /ram/e/stale')).stdout)).toBe('gone\n')
      expect(DEC.decode((await ws.shell('readlink /ram/d/inner')).stdout)).toBe('a.txt\n')
    } finally {
      await ws.close()
    }
  })

  it('replaces an empty rename destination', async () => {
    // The other half of rename(2): a destination with nothing in it is
    // replaced, and the subtree re-anchors onto the new name.
    const ws = await linkWorkspace()
    try {
      await ws.shell('echo hi > /ram/d/a.txt')
      await ws.shell('ln -s a.txt /ram/d/inner')
      await ws.shell('mkdir /ram/e')
      await ws.dispatch('rename', '/ram/d', [PathSpec.fromStrPath('/ram/e')])
      expect(DEC.decode((await ws.shell('readlink /ram/e/inner')).stdout)).toBe('a.txt\n')
      expect((await ws.shell('readlink /ram/d/inner')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('merges a tree copy beside a link at the destination', async () => {
    // Only a rename asks for an empty destination: a copy merges into the
    // directory and the link already there stays.
    const ws = await linkWorkspace()
    try {
      await ws.shell('echo hi > /ram/d/a.txt')
      await ws.shell('mkdir -p /ram/e/d')
      await ws.shell('ln -s gone /ram/e/d/stale')
      const res = await ws.shell('cp -r /ram/d /ram/e')
      expect(res.exitCode).toBe(0)
      expect(DEC.decode((await ws.shell('cat /ram/e/d/a.txt')).stdout)).toBe('hi\n')
      expect(DEC.decode((await ws.shell('readlink /ram/e/d/stale')).stdout)).toBe('gone\n')
    } finally {
      await ws.close()
    }
  })

  it('drops the listing an empty directory a tree copy made joins', async () => {
    // The copy wrote no file, so only the directory it made says which
    // listing changed.
    const ws = new Workspace({ '/ram/': new TreeCopyRAM() }, { mode: MountMode.WRITE })
    try {
      await ws.shell('mkdir -p /ram/s/e /ram/d && echo x > /ram/d/x')
      expect(DEC.decode((await ws.shell('ls /ram/d')).stdout)).toBe('x\n')
      await ws.dispatch('dir_copy', '/ram/s', [PathSpec.fromStrPath('/ram/d')])
      expect(DEC.decode((await ws.shell('ls /ram/d')).stdout)).toBe('e\nx\n')
    } finally {
      await ws.close()
    }
  })

  it('copies through a link at the destination', async () => {
    // A copy writes its destination as a write does: the bytes land in the
    // link's target and the link stays.
    const ws = await linkWorkspace()
    try {
      await ws.shell('echo tgt > /ram/t.txt')
      await ws.shell('ln -s t.txt /ram/to-t')
      await ws.dispatch('copy', '/ram/a.txt', [PathSpec.fromStrPath('/ram/to-t')])
      expect(DEC.decode((await ws.shell('readlink /ram/to-t')).stdout)).toBe('t.txt\n')
      expect(DEC.decode((await ws.shell('cat /ram/t.txt')).stdout)).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })

  it('refuses a copy onto a link to its own source', async () => {
    // Followed, both ends name one file, and a backend that replaces its
    // destination would delete the source before copying it.
    const ws = await linkWorkspace()
    try {
      await expect(
        ws.dispatch('copy', '/ram/a.txt', [PathSpec.fromStrPath('/ram/link')]),
      ).rejects.toMatchObject({ code: 'EINVAL' })
      expect(DEC.decode((await ws.shell('cat /ram/a.txt')).stdout)).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })

  it('declines a tree copy over a link below its destination', async () => {
    // The backend writes each child name as it is, so the bytes would land
    // behind the link; the caller's walk copies through it instead.
    const ws = await linkWorkspace()
    try {
      await ws.shell('echo new > /ram/d/x')
      await ws.shell('mkdir -p /ram/e/d')
      await ws.shell('echo old > /ram/t && ln -s /ram/t /ram/e/d/x')
      await expect(
        ws.dispatch('dir_copy', '/ram/d', [PathSpec.fromStrPath('/ram/e/d')]),
      ).rejects.toMatchObject({ declined: true })
      expect((await ws.shell('cp -r /ram/d /ram/e')).exitCode).toBe(0)
      expect(DEC.decode((await ws.shell('cat /ram/t')).stdout)).toBe('new\n')
    } finally {
      await ws.close()
    }
  })

  it('writes a tree copy through a link into another mount', async () => {
    // cp walks a destination holding a link, and the write follows it
    // across mounts where a backend copy would answer EXDEV.
    const ws = new Workspace(
      { '/ram': new RAMVFS(), '/scratch': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    try {
      await ws.shell('mkdir -p /ram/d /ram/e/d && echo new > /ram/d/a.txt')
      await ws.shell('echo old > /scratch/a.txt')
      await ws.shell('ln -s /scratch/a.txt /ram/e/d/a.txt')
      expect((await ws.shell('cp -r /ram/d /ram/e')).exitCode).toBe(0)
      expect(DEC.decode((await ws.shell('cat /scratch/a.txt')).stdout)).toBe('new\n')
      expect(DEC.decode((await ws.shell('readlink /ram/e/d/a.txt')).stdout)).toBe(
        '/scratch/a.txt\n',
      )
    } finally {
      await ws.close()
    }
  })

  it('answers a no-follow stat with the link row', async () => {
    // lstat asks for the row only the node table holds; a following stat
    // arrives resolved to the target and must not see a link at all.
    const ws = await linkWorkspace()
    try {
      const row = (await ws.dispatch('stat', '/ram/link', [], { nofollow: true })) as {
        type: string
        size: number
      }
      expect(row.type).toBe('symlink')
      expect(row.size).toBe('a.txt'.length)
      const followed = (await ws.dispatch('stat', '/ram/link')) as { type: string }
      expect(followed.type).not.toBe('symlink')
    } finally {
      await ws.close()
    }
  })

  it('replaces a link that sits at a rename destination', async () => {
    // rename(2) replaces the destination. A link left in the table there
    // shadowed the file that had just landed: the listing showed the new
    // file, every read followed the old link, and the moved content was
    // reachable under no name at all. mv did this right at the command
    // tier, so only the surfaces below it (a guest, a kernel mount) saw
    // the broken state.
    const ws = await linkWorkspace()
    try {
      await ws.dispatch('rename', '/ram/a.txt', [PathSpec.fromStrPath('/ram/link')])
      expect(DEC.decode((await ws.shell('cat /ram/link')).stdout)).toBe('hi\n')
      expect((await ws.shell('readlink /ram/link')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('refuses a symlink onto a name that is taken', async () => {
    // symlink(2) is EEXIST on an occupied name, and only the dispatcher can
    // tell: a file and a directory are the backend's, a link is the node
    // table's, and a mount root is the registry's. Unchecked, the node
    // went on top and buried whatever was there.
    const ws = await linkWorkspace()
    try {
      for (const occupied of ['/ram/a.txt', '/ram/d', '/ram/link', '/ram']) {
        await expect(
          ws.dispatch('symlink', occupied, [], { target: 'elsewhere' }),
        ).rejects.toMatchObject({ code: 'EEXIST' })
      }
      expect(DEC.decode((await ws.shell('cat /ram/a.txt')).stdout)).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })

  it('refuses a symlink whose parent cannot hold it', async () => {
    // symlink(2) resolves the directory a name goes in before the name:
    // ENOENT when it is absent, ENOTDIR when a plain file stands in the
    // chain at any depth, and a link above the name is followed first.
    // Unchecked, the node was an orphan that invented the directories above
    // it, which ls then listed.
    const ws = await linkWorkspace()
    try {
      await ws.shell('ln -s missing /ram/dangling')
      const cases: [string, string][] = [
        ['/ram/nope/y', 'ENOENT'],
        ['/ram/nope/deeper/y', 'ENOENT'],
        ['/ram/dangling/y', 'ENOENT'],
        ['/ram/a.txt/y', 'ENOTDIR'],
        ['/ram/a.txt/sub/y', 'ENOTDIR'],
        ['/ram/link/y', 'ENOTDIR'],
      ]
      for (const [name, code] of cases) {
        await expect(ws.dispatch('symlink', name, [], { target: 'x' })).rejects.toMatchObject({
          code,
        })
      }
      expect([...ws.namespace.symlinkTargets().keys()].sort()).toEqual([
        '/ram/dangling',
        '/ram/link',
      ])
      expect(DEC.decode((await ws.shell('ls /ram')).stdout)).toBe('a.txt\nd\ndangling\nlink\n')
    } finally {
      await ws.close()
    }
  })

  it('files a link made under a linked directory in its target', async () => {
    // Every link above the final name is followed before the op sees the
    // path, whichever surface named it. The node table filed a relative
    // `ln -s t alias/x` under the alias's own name, where no listing of the
    // directory and no read through it ever looked.
    const ws = await linkWorkspace()
    try {
      await ws.shell('mkdir /ram/e; ln -s d /ram/alias')
      await ws.dispatch('symlink', '/ram/alias/x', [], { target: 't' })
      await ws.dispatch('symlink', '/ram/e/empty', [], { target: 't' })
      expect(ws.namespace.readlink('/ram/d/x')).toBe('t')
      expect(ws.namespace.isLink('/ram/alias/x')).toBe(false)
      expect(await ws.dispatch('readlink', '/ram/alias/x')).toBe('t')
      expect(ws.namespace.readlink('/ram/e/empty')).toBe('t')
    } finally {
      await ws.close()
    }
  })

  it('refuses a link rename whose landing parent cannot hold it', async () => {
    // rename(2) resolves the destination's directory as symlink(2) does,
    // and the node table moved a link anywhere at all.
    const ws = await linkWorkspace()
    try {
      for (const [landing, code] of [
        ['/ram/nope/x', 'ENOENT'],
        ['/ram/a.txt/x', 'ENOTDIR'],
      ] as const) {
        await expect(
          ws.dispatch('rename', '/ram/link', [PathSpec.fromStrPath(landing)]),
        ).rejects.toMatchObject({ code })
        expect(ws.namespace.isLink(landing)).toBe(false)
      }
      expect(ws.namespace.readlink('/ram/link')).toBe('a.txt')
    } finally {
      await ws.close()
    }
  })
})

describe('the fenced remnant cascade rides the mount revisions', () => {
  it('a fenced backend op reads the pinned revision', async () => {
    // fencedCall reruns backend ops outside `dispatch`, and Python's
    // twin routes them through `Mount.call`, which binds the
    // mount prefix AND the revision pins. A fenced readdir/stat that
    // reads unpinned answers from the wrong version of a
    // revision-pinned mount, so the binding is pinned here through the
    // one public trigger: an rmdir whose only remnants the session
    // cannot see.
    const ram = new RAMVFS()
    const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE })
    try {
      await ws.shell('mkdir /ram/d && echo x > /ram/d/h.txt')
      const original = ram.readdir.bind(ram)
      let seen: string | null | undefined
      ram.readdir = (path) => {
        seen = revisionFor('/ram/d/h.txt')
        return original(path)
      }
      const internals = ws as unknown as {
        registry: { mountFor(path: string): { revisions: Map<string, string> } }
      }
      internals.registry.mountFor('/ram/d').revisions.set('/ram/d/h.txt', 'r1')
      const sess = new SessionState({
        sessionId: 'agent',
        visibility: { paths: { paths: ['/ram/d/h.txt'] } },
      })
      await runWithSession(sess, () => ws.dispatch('rmdir', '/ram/d'))
      expect(seen).toBe('r1')
    } finally {
      await ws.close()
    }
  }, 30_000)
})

describe('the turf mode gates the node table', () => {
  it('a read grant refuses link writes like file writes', async () => {
    // The mode gate on the table ops. A read grant refused a file's
    // unlink with EROFS while the same session deleted, created and
    // renamed its sibling link: the table verbs ran no mode check at
    // all, so `mounts: {"/extra": "read"}` protected everything on the
    // mount except its names.
    const ws = new Workspace({ '/extra': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.shell('echo b > /extra/plain.txt')
      await ws.shell('ln -s plain.txt /extra/lk')
      const sess = ws.createSession('agent', { mounts: { '/extra/': 'read' } })
      await runWithSession(sess, async () => {
        await expect(ws.dispatch('unlink', '/extra/lk')).rejects.toMatchObject({
          code: 'EROFS',
        })
        await expect(
          ws.dispatch('symlink', '/extra/lk2', [], { target: 'plain.txt' }),
        ).rejects.toMatchObject({ code: 'EROFS' })
        await expect(
          ws.dispatch('rename', '/extra/lk', [PathSpec.fromStrPath('/extra/mv')]),
        ).rejects.toMatchObject({ code: 'EROFS' })
      })
      expect(DEC.decode((await ws.shell('readlink /extra/lk')).stdout)).toBe('plain.txt\n')
      expect((await ws.shell('readlink /extra/lk2')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  // mkdir looks its name up first (a read-only mkdir answers what its name holds).
  it.each([...POLICY_WRITE_OPS].filter((op) => op !== 'mkdir'))(
    '%s refuses before backend support and I/O',
    async (op) => {
      const ws = new Workspace({ '/ro': [new RAMVFS(), MountMode.READ] })
      try {
        const mount = ws.namespace.mountFor('/ro/file')
        const ready = vi.spyOn(mount, 'ensureReady').mockRejectedValue(new Error('backend reached'))
        // A copy reads its path and writes its destination.
        const dst = op.includes('copy') ? [PathSpec.fromStrPath('/ro/copy')] : undefined
        await expect(ws.dispatch(op, '/ro/file', dst)).rejects.toMatchObject({ code: 'EROFS' })
        expect(ready).not.toHaveBeenCalled()
        expect(ws.namespace.isLink('/ro/file')).toBe(false)
      } finally {
        await ws.close()
      }
    },
  )

  it.each([
    ['/ro/d', false, 'EEXIST'],
    ['/ro/d', true, null],
    ['/ro/f', false, 'EEXIST'],
    ['/ro/f/x', false, 'ENOTDIR'],
    ['/ro/gone/x', false, 'ENOENT'],
    ['/ro/gone/x', true, 'EROFS'],
    ['/ro/new', false, 'EROFS'],
  ] as const)('a read-only mkdir of %s (parents %s) answers %s', async (path, parents, code) => {
    // mkdir(2) on a read-only filesystem refuses only a create it would
    // really make: a taken name is EEXIST, a file in the chain ENOTDIR, and
    // `mkdir -p` of a directory already there succeeds.
    const ram = new RAMVFS()
    ram.store.files.set('/f', ENC.encode('x'))
    ram.store.dirs.add('/d')
    const ws = new Workspace({ '/ro': [ram, MountMode.READ] })
    try {
      const call = ws.dispatch('mkdir', path, [], { parents })
      if (code === null) await call
      else await expect(call).rejects.toMatchObject({ code })
    } finally {
      await ws.close()
    }
  })

  it('a policy refusal stands on a read-only mkdir', async () => {
    // The lookup answers for the mount's mode, never for a policy: a
    // policy's own read-only refusal stands where the directory exists.
    const refuse: Policy = {
      preVfs: (ctx: VfsContext) =>
        ctx.call.name === 'mkdir'
          ? { kind: 'deny', reason: 'no dirs', error: erofs(ctx.path.virtual) }
          : null,
    }
    const ram = new RAMVFS()
    ram.store.dirs.add('/d')
    const ws = new Workspace({ '/ro': [ram, MountMode.READ] }, { policies: [refuse] })
    try {
      await expect(ws.dispatch('mkdir', '/ro/d', [], { parents: true })).rejects.toMatchObject({
        code: 'EROFS',
      })
    } finally {
      await ws.close()
    }
  })

  it('a read-only mkdir the lookup answers completes', async () => {
    // `mkdir -p` of a directory already there succeeds, through postVfs
    // like any op that succeeds.
    const done: string[] = []
    const seen: Policy = {
      postVfs: (ctx: VfsResultContext) => {
        if (ctx.call.name === 'mkdir') done.push(ctx.path.virtual)
        return null
      },
    }
    const ram = new RAMVFS()
    ram.store.dirs.add('/d')
    const ws = new Workspace({ '/ro': [ram, MountMode.READ] }, { policies: [seen] })
    try {
      await ws.dispatch('mkdir', '/ro/d', [], { parents: true })
      expect(done).toEqual(['/ro/d'])
    } finally {
      await ws.close()
    }
  })

  it("an op's issuer reaches postVfs as it reaches preVfs", async () => {
    // A policy tells its own reads apart by the issuer on both sides of
    // the call; without task isolation nothing else does.
    const issuer = Symbol('policy read')
    const seen: (symbol | undefined)[] = []
    const marks: Policy = {
      preVfs: (ctx: VfsContext) => {
        seen.push(ctx.issuer)
        return null
      },
      postVfs: (ctx: VfsResultContext) => {
        seen.push(ctx.issuer)
        return null
      },
    }
    const ram = new RAMVFS()
    ram.store.files.set('/f', new TextEncoder().encode('x'))
    const ws = new Workspace({ '/data': ram }, { policies: [marks] })
    try {
      await ws.dispatch('read', '/data/f', [], { issuer })
      expect(seen).toEqual([issuer, issuer])
    } finally {
      await ws.close()
    }
  })

  it('a rename destination is judged on its own turf', async () => {
    // The endpoints need not share a turf, and each is scored against
    // its own prefix: a grant writing /rw but only reading /ro refuses,
    // blaming the destination, the way the backend gate checks both ends
    // of a rename. The grant is what binds, so both mounts are writable
    // and the session is the only thing narrowing either.
    const ws = new Workspace(
      { '/rw': new RAMVFS(), '/ro': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    try {
      await ws.shell('ln -s t /rw/lk')
      const sess = ws.createSession('agent', {
        mounts: { '/rw/': 'write', '/ro/': 'read' },
      })
      await runWithSession(sess, async () => {
        await expect(
          ws.dispatch('rename', '/rw/lk', [PathSpec.fromStrPath('/ro/lk')]),
        ).rejects.toMatchObject({ code: 'EROFS', virtualPath: '/ro/lk' })
      })
      expect(ws.namespace.isLink('/rw/lk')).toBe(true)
    } finally {
      await ws.close()
    }
  })
})

describe('a rename moves what the node table holds', () => {
  it('carries the node at the source itself', async () => {
    // The subtree below the source was re-anchored and the source's own
    // node was not, so an overlay recorded there stayed at the emptied
    // name: it never reached the landing, and whatever was created at
    // the old name next inherited it.
    const ws = new Workspace({ '/a': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.shell('printf one > /a/f.txt')
      await ws.namespace.setAttrs('/a/f.txt', { mode: 0o400 })
      await ws.dispatch('rename', '/a/f.txt', [PathSpec.fromStrPath('/a/g.txt')])
      expect(ws.namespace.metaFor('/a/f.txt')).toBeNull()
      expect(ws.namespace.metaFor('/a/g.txt')?.mode).toBe(0o400)
    } finally {
      await ws.close()
    }
  })

  it('replaces the node at the landing', async () => {
    // rename(2) replaces the destination, so the overlay it carried
    // goes with it rather than staying to shadow what just landed; what
    // lands there is the moved file's own node, its write time included.
    const ws = new Workspace({ '/a': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.shell('printf one > /a/f.txt && printf two > /a/g.txt')
      await ws.namespace.setAttrs('/a/g.txt', { mode: 0o400 })
      const moved = ws.namespace.metaFor('/a/f.txt')
      await ws.dispatch('rename', '/a/f.txt', [PathSpec.fromStrPath('/a/g.txt')])
      expect(ws.namespace.metaFor('/a/g.txt')).toEqual(moved)
    } finally {
      await ws.close()
    }
  })
})

describe('a hide answers a create by what its parent answers', () => {
  it('under a hidden directory a create is ENOENT, at a hidden name under a visible one EACCES', async () => {
    // Every read on a hidden directory answered ENOENT while a create
    // beneath it answered EACCES, so a session could map a profile's
    // hidden prefixes by probing writes. The parent decides, a rename
    // destination is a create, and the shell's redirect renders the
    // same refusal an ordinary missing directory does.
    const ws = new Workspace({ '/ram': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.shell(
        'mkdir -p /ram/vault /ram/open && echo s > /ram/vault/secret && echo p > /ram/open/pub.txt && echo q > /ram/open/q.txt',
      )
      const sess = ws.createSession('agent', {
        profile: { paths: { hide: ['/ram/vault', '/ram/open/pub.txt'] } },
      })
      await runWithSession(sess, async () => {
        await expect(
          ws.dispatch('write', '/ram/vault/new.txt', [ENC.encode('x')]),
        ).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(ws.dispatch('mkdir', '/ram/vault/deeper')).rejects.toMatchObject({
          code: 'ENOENT',
        })
        // truncate creates a missing file at the requested length, so
        // it is a create too.
        await expect(ws.dispatch('truncate', '/ram/vault/new.txt', [0])).rejects.toMatchObject({
          code: 'ENOENT',
        })
        await expect(ws.dispatch('truncate', '/ram/open/pub.txt', [0])).rejects.toMatchObject({
          code: 'EACCES',
        })
        await expect(
          ws.dispatch('rename', '/ram/open/q.txt', [PathSpec.fromStrPath('/ram/vault/moved')]),
        ).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(ws.dispatch('mkdir', '/ram/vault')).rejects.toMatchObject({ code: 'EACCES' })
        await expect(
          ws.dispatch('write', '/ram/open/pub.txt', [ENC.encode('x')]),
        ).rejects.toMatchObject({ code: 'EACCES' })
        await expect(
          ws.dispatch('rename', '/ram/open/q.txt', [PathSpec.fromStrPath('/ram/open/pub.txt')]),
        ).rejects.toMatchObject({ code: 'EACCES' })
      })
      const under = await ws.shell('echo x > /ram/vault/new.txt', { sessionId: 'agent' })
      expect(DEC.decode(under.stderr)).toBe('/ram/vault/new.txt: No such file or directory\n')
      const control = await ws.shell('echo x > /ram/ghost/new.txt', { sessionId: 'agent' })
      expect(DEC.decode(control.stderr)).toBe('/ram/ghost/new.txt: No such file or directory\n')
      expect(DEC.decode((await ws.shell('cat /ram/vault/secret')).stdout)).toBe('s\n')
    } finally {
      await ws.close()
    }
  })
})

describe('a failed backend probe is not evidence of absence', () => {
  it('symlink refuses a name whose backend could not answer', async () => {
    class BrokenVFS extends RAMVFS {
      override stat(): Promise<FileStat> {
        return Promise.reject(new Error('401 bad credentials'))
      }
    }
    const broken = new BrokenVFS()
    const ws = new Workspace({ '/r': new RAMVFS(), '/data': broken }, { mode: MountMode.EXEC })
    try {
      // The dispatcher probes the name before linking over it. A backend that
      // cannot answer has not reported the name free, so the link must not
      // be created on the strength of that failure.
      await expect(
        ws.dispatch('symlink', '/data/notes.txt', [], { target: '/r/t' }),
      ).rejects.toThrow('401 bad credentials')
    } finally {
      await ws.close()
    }
  }, 30_000)

  it('a failing parent listing propagates out of the parent-listing probe', async () => {
    const listing = new RAMVFS()
    // The store's key iteration is reached only by the parent readdir, not
    // by the stat probe ahead of it, so this fails exactly the one channel.
    vi.spyOn(listing.store.files, 'keys').mockImplementation(() => {
      throw new Error('backend listing failed')
    })
    const ws = new Workspace({ '/r': new RAMVFS(), '/data': listing }, { mode: MountMode.EXEC })
    try {
      // The stat probe misses on a name RAM does not hold, which is the
      // one route into the parent-listing probe. The parent's readdir is
      // the channel that fails there, and a channel that could not answer
      // is not a name reported free.
      await expect(
        ws.dispatch('symlink', '/data/notes.txt', [], { target: '/r/t' }),
      ).rejects.toThrow('backend listing failed')
    } finally {
      await ws.close()
    }
  }, 30_000)

  it('readlink still answers ENOENT where no mount serves the path', async () => {
    const ws = new Workspace({ '/r': new RAMVFS() }, { mode: MountMode.EXEC })
    try {
      await expect(ws.dispatch('readlink', '/nowhere/x')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ws.close()
    }
  }, 30_000)
})

describe('the dispatcher answers extended attributes from the node table', () => {
  const open = async (): Promise<Workspace> => {
    const ws = new Workspace({ '/r': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('printf x > /r/f && ln -s f /r/lk')
    return ws
  }

  it('stores them on the node and lists them sorted', async () => {
    const ws = await open()
    try {
      await ws.vfs.setxattr('/r/f', 'user.b', ENC.encode('two'))
      await ws.vfs.setxattr('/r/f', 'user.a', ENC.encode('one'))
      expect(await ws.vfs.listxattr('/r/f')).toEqual(['user.a', 'user.b'])
      expect(DEC.decode(await ws.vfs.getxattr('/r/f', 'user.b'))).toBe('two')
      await ws.vfs.removexattr('/r/f', 'user.b')
      expect(await ws.vfs.listxattr('/r/f')).toEqual(['user.a'])
      await expect(ws.vfs.getxattr('/r/f', 'user.b')).rejects.toMatchObject({ code: 'ENODATA' })
    } finally {
      await ws.close()
    }
  })

  it('refuses the way setxattr(2) does for its flags', async () => {
    const ws = await open()
    try {
      await ws.vfs.setxattr('/r/f', 'user.a', ENC.encode('one'))
      await expect(
        ws.vfs.setxattr('/r/f', 'user.a', ENC.encode('two'), { create: true }),
      ).rejects.toMatchObject({ code: 'EEXIST' })
      await expect(
        ws.vfs.setxattr('/r/f', 'user.q', ENC.encode('x'), { replace: true }),
      ).rejects.toMatchObject({ code: 'ENODATA' })
      await ws.vfs.setxattr('/r/f', 'user.a', ENC.encode('two'), { replace: true })
      expect(DEC.decode(await ws.vfs.getxattr('/r/f', 'user.a'))).toBe('two')
    } finally {
      await ws.close()
    }
  })

  it('answers ENOENT for a missing path and stores nothing there', async () => {
    const ws = await open()
    try {
      await expect(ws.vfs.listxattr('/r/nope')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(ws.vfs.setxattr('/r/nope', 'user.a', ENC.encode('x'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(ws.namespace.metaFor('/r/nope')).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('drops them with the file and carries them through a rename', async () => {
    // Removed through the dispatcher rather than the shell's rm, the node
    // stayed, and a file created at the name next read back the old
    // file's attributes.
    const ws = await open()
    try {
      await ws.vfs.setxattr('/r/f', 'user.a', ENC.encode('one'))
      await ws.vfs.rename('/r/f', '/r/g')
      expect(DEC.decode(await ws.vfs.getxattr('/r/g', 'user.a'))).toBe('one')
      expect(ws.namespace.metaFor('/r/f')).toBeNull()
      await ws.vfs.unlink('/r/g')
      await ws.shell('printf y > /r/g')
      expect(await ws.vfs.listxattr('/r/g')).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('reads a link node itself under nofollow', async () => {
    const ws = await open()
    try {
      await ws.vfs.setxattr('/r/lk', 'user.target', ENC.encode('t'))
      await ws.vfs.setxattr('/r/lk', 'user.own', ENC.encode('o'), { nofollow: true })
      expect(await ws.vfs.listxattr('/r/lk')).toEqual(['user.target'])
      expect(await ws.vfs.listxattr('/r/lk', { nofollow: true })).toEqual(['user.own'])
      expect(ws.namespace.readlink('/r/lk')).toBe('f')
    } finally {
      await ws.close()
    }
  })

  it("keeps a backend stat's extra out of the attributes", async () => {
    const ws = await open()
    const mount = ws.mount('/r')
    const call = mount.callKeyed.bind(mount)
    const stat = vi.spyOn(mount, 'callKeyed')
    stat.mockImplementation(async (op, ...rest) => {
      if (op === 'stat') {
        return new FileStat({ name: 'd', type: FileType.DIRECTORY, extra: { file_id: '1AbC' } })
      }
      return call(op, ...rest)
    })
    try {
      await ws.vfs.setxattr('/r/f', 'user.tag', ENC.encode('t'))
      expect(await ws.vfs.listxattr('/r/f')).toEqual(['user.tag'])
    } finally {
      stat.mockRestore()
      await ws.close()
    }
  })
})

describe('shell mutations share read-only admission', () => {
  it.each([
    ['echo x >> /ro/file', '/ro/file: Read-only file system\n'],
    ['exec >> /ro/file', '/ro/file: Read-only file system\n'],
    [
      'ln -s file /ro/link',
      "ln: failed to create symbolic link '/ro/link': Read-only file system\n",
    ],
    ['chmod 600 /ro/file', "chmod: changing permissions of '/ro/file': Read-only file system\n"],
    ['find /ro/file -delete', "find: cannot delete '/ro/file': Read-only file system\n"],
    ['rm /ro/file', "rm: cannot remove '/ro/file': Read-only file system\n"],
    ['mv /ro/file /ro/moved', "mv: cannot move '/ro/file' to '/ro/moved': Read-only file system\n"],
    ['touch /ro/file', "touch: cannot touch '/ro/file': Read-only file system\n"],
    [
      'truncate -s 0 /ro/file',
      "truncate: cannot open '/ro/file' for writing: Read-only file system\n",
    ],
  ])('%s', async (command, diagnostic) => {
    const ws = new Workspace({ '/ro': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.dispatch('write', '/ro/file', [ENC.encode('original')])
      ws.namespace.mountFor('/ro/file').mode = MountMode.READ
      const read = vi.spyOn(ws.mount('/ro'), 'callKeyed')
      const result = await ws.shell(command)
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(await materialize(result.stderr))).toBe(diagnostic)
      expect(read.mock.calls.some(([op]) => op === 'read' || op === 'read_bytes')).toBe(false)
      expect(ws.namespace.isLink('/ro/link')).toBe(false)
      expect(DEC.decode((await ws.dispatch('read', '/ro/file')) as Uint8Array)).toBe('original')
    } finally {
      await ws.close()
    }
  })
})

describe('a write reads the mode again as it starts', () => {
  it('refuses a write whose mount turned read-only while it waited', async () => {
    // Admission judged the mount writable before the write waited for the
    // mount; made read-only meanwhile, the mount refuses the write as the
    // backend call starts.
    const ram = new RAMVFS()
    const ws = new Workspace({ '/rw': ram }, { mode: MountMode.WRITE })
    try {
      const mount = ws.namespace.mountFor('/rw/file')
      const ready = mount.ensureReady.bind(mount)
      vi.spyOn(mount, 'ensureReady').mockImplementation(async () => {
        ws.setMountMode('/rw', MountMode.READ)
        await ready()
      })
      await expect(ws.dispatch('write', '/rw/file', [ENC.encode('x')])).rejects.toMatchObject({
        code: 'EROFS',
      })
      expect(await ram.exists(PathSpec.fromStrPath('/file'))).toBe(false)
    } finally {
      await ws.close()
    }
  })
})

describe('links into hidden space', () => {
  it('are hidden with their target', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.shell(
        'mkdir -p /data/secret /data/pub /data/shared; ' +
          'echo s > /data/secret/f; echo p > /data/pub/n.txt; ' +
          'ln -s /data/secret/f /data/shared/to_secret; ' +
          'ln -s ../secret /data/shared/dirlink; ' +
          'ln -s /data/pub/n.txt /data/shared/to_pub',
      )
      const bob = ws.createSession('bob', { profile: { paths: { hide: ['/data/secret'] } } })
      const gone = 'No such file or directory'
      for (const [line, out, err, code] of [
        ['ls /data/shared', 'to_pub\n', '', 0],
        ['readlink /data/shared/to_secret', '', '', 1],
        [
          'stat -c %N /data/shared/to_secret',
          '',
          `stat: cannot statx '/data/shared/to_secret': ${gone}\n`,
          1,
        ],
        ['ls /data/shared/dirlink', '', `ls: cannot access '/data/shared/dirlink': ${gone}\n`, 2],
        ['find /data/shared', '/data/shared\n/data/shared/to_pub\n', '', 0],
        [
          'rm /data/shared/to_secret',
          '',
          `rm: cannot remove '/data/shared/to_secret': ${gone}\n`,
          1,
        ],
      ] as const) {
        const result = await ws.shell(line, { sessionId: 'bob' })
        expect(
          [DEC.decode(result.stdout), DEC.decode(result.stderr), result.exitCode],
          line,
        ).toEqual([out, err, code])
      }
      await runWithSession(bob, async () => {
        for (const call of [
          () => ws.vfs.read('/data/shared/to_secret'),
          () => ws.vfs.readlink('/data/shared/to_secret'),
        ]) {
          await expect(call()).rejects.toMatchObject({
            code: 'ENOENT',
            virtualPath: '/data/shared/to_secret',
          })
        }
      })
      expect(DEC.decode((await ws.shell('readlink /data/shared/to_secret')).stdout)).toBe(
        '/data/secret/f\n',
      )
    } finally {
      await ws.close()
    }
  })
})

describe('rmdir namespace entries', () => {
  it.each([false, true])(
    'accounts for a directory containing only a link (hidden=%s)',
    async (hidden) => {
      const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
      try {
        await ws.shell('mkdir /data/d; ln -s nowhere /data/d/link')
        const session = ws.createSession('remover', {
          profile: { paths: { hide: hidden ? ['/data/d/link'] : [] } },
        })
        await runWithSession(session, async () => {
          if (hidden) await ws.vfs.rmdir('/data/d')
          else await expect(ws.vfs.rmdir('/data/d')).rejects.toMatchObject({ code: 'ENOTEMPTY' })
        })
        expect(ws.namespace.isLink('/data/d/link')).toBe(!hidden)
      } finally {
        await ws.close()
      }
    },
  )

  it('takes a link into hidden space with the directory', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.shell(
        'mkdir -p /data/secret /data/d; echo s > /data/secret/f; ln -s /data/secret/f /data/d/l',
      )
      const session = ws.createSession('remover', {
        profile: { paths: { hide: ['/data/secret'] } },
      })
      await runWithSession(session, () => ws.vfs.rmdir('/data/d'))
      expect(ws.namespace.isLink('/data/d/l')).toBe(false)
      expect(DEC.decode((await ws.shell('ls /data')).stdout)).toBe('secret\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps a link created while the backend removes the directory', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.shell('mkdir /data/d; ln -s nowhere /data/d/old')
      const mount = ws.mount('/data')
      const call = mount.callKeyed.bind(mount)
      vi.spyOn(mount, 'callKeyed').mockImplementation(async (name, ...rest) => {
        if (name === 'rmdir')
          await ws.dispatch('symlink', '/data/d/late', [], { target: 'nowhere' })
        return call(name, ...rest)
      })
      const session = ws.createSession('remover', {
        profile: { paths: { hide: ['/data/d/old'] } },
      })
      await runWithSession(session, () => ws.vfs.rmdir('/data/d'))
      expect(ws.namespace.isLink('/data/d/old')).toBe(false)
      expect(ws.namespace.readlink('/data/d/late')).toBe('nowhere')
    } finally {
      await ws.close()
    }
  })
})

describe('a cold read keeps its bytes for the next reader', () => {
  // A caching mount whose reads answer BODY, one tally per fetch. The
  // counted read replaces the mount's plain read, or with `filetype`
  // renders only that extension; with `race` the first fetch is overtaken
  // by a write. Mirrors Python's tests/workspace/dispatcher/test_dispatcher.py.
  function counted(
    race = false,
    filetype: string | null = null,
  ): { ws: Workspace; fetched: string[] } {
    const fetched: string[] = []
    const vfs = new RAMVFS()
    Object.assign(vfs, { cachesReads: true })
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })
    const read = async (
      path: PathSpec,
      _index?: IndexCacheStore,
      offset = 0,
      size: number | null = null,
    ): Promise<Uint8Array> => {
      fetched.push(path.virtual)
      if (race && fetched.length === 1) await ws.vfs.write('/data/f.count', 'NEWER')
      return sliceWindow(ENC.encode('BODY'), offset, size)
    }
    if (filetype === null) Object.assign(vfs, { readsRanges: false, read })
    else render(vfs, filetype, read)
    return { ws, fetched }
  }

  it('serves the ranges of an unranged read from one kept read', async () => {
    // A read op with no remote range would fetch the whole file and slice
    // it for every range, so the first range keeps the file and the rest,
    // and the whole read, are served from it.
    const { ws, fetched } = counted()
    await ws.vfs.write('/data/f.count', 'STORED')
    await ws.cache.remove('/data/f.count')
    expect(DEC.decode(await ws.vfs.read('/data/f.count', { offset: 0, size: 2 }))).toBe('BO')
    expect(DEC.decode(await ws.vfs.read('/data/f.count', { offset: 2, size: 2 }))).toBe('DY')
    expect(DEC.decode(await ws.vfs.read('/data/f.count', { offset: 0, size: 0 }))).toBe('')
    expect(DEC.decode(await ws.vfs.read('/data/f.count'))).toBe('BODY')
    expect(fetched).toEqual(['/data/f.count'])
  })

  it('keeps what a command reads from a raw read', async () => {
    // The stored bytes are what the cache holds under the path, so the cat
    // after a raw read is served warm.
    const { ws, fetched } = counted(false, '.count')
    await ws.vfs.write('/data/f.count', 'STORED')
    expect(DEC.decode(await ws.vfs.read('/data/f.count', { raw: true }))).toBe('STORED')
    expect(await ws.cache.get('/data/f.count')).toEqual(ENC.encode('STORED'))
    expect(DEC.decode((await ws.shell('cat /data/f.count')).stdout)).toBe('STORED')
    expect(fetched).toEqual([])
  })

  it('neither serves nor keeps the cache on a direct read', async () => {
    // A follow's poll asks for what the backend holds now: the warm copy is
    // not served, and the read leaves the cache as it found it.
    const { ws, fetched } = counted()
    await ws.cache.set('/data/f.count', ENC.encode('WARM'))
    const read = async (kwargs: Record<string, unknown>): Promise<string> => {
      const data = await ws.dispatch('read', '/data/f.count', [], { ...kwargs, direct: true })
      return DEC.decode(data as Uint8Array)
    }
    expect([await read({}), await read({ offset: 1, size: 2 })]).toEqual(['BODY', 'OD'])
    expect(fetched).toEqual(['/data/f.count', '/data/f.count'])
    expect(await ws.cache.get('/data/f.count')).toEqual(ENC.encode('WARM'))
    await ws.cache.remove('/data/f.count')
    await ws.dispatch('read', '/data/f.count', [], { direct: true })
    expect(await ws.cache.exists('/data/f.count')).toBe(false)
  })

  it.each([
    ['an idle', (): Promise<{ ts: string }[]> => Promise.resolve([])],
    ['a stalled', (): Promise<{ ts: string }[]> => new Promise(() => undefined)],
  ])('closes %s follow through the mount', async (_kind, answer) => {
    // A follow past its day waits to be closed, idle or on an ask the
    // backend never answers; that close has to reach it through the mount's
    // wrappers while a pull waits, or the follow holds the mount forever.
    // Mirrors python's test_a_waiting_follow_closes_through_the_mount.
    let asked = (): void => undefined
    const polled = new Promise<void>((resolve) => {
      asked = resolve
    })
    class FollowedRAM extends RAMVFS {
      override follow(): Promise<AsyncIterable<Uint8Array> | null> {
        return Promise.resolve(
          followedDay([{ ts: '1' }], 1, 0, 0.001, () => {
            asked()
            return answer()
          }),
        )
      }
    }
    const ws = new Workspace({ '/m': new FollowedRAM() }, { mode: MountMode.WRITE })
    try {
      await ws.vfs.write('/m/day', '{"ts":"1"}\n')
      const stream = (await ws.dispatch(
        'follow',
        '/m/day',
        [1, 0.001],
      )) as AsyncIterable<Uint8Array>
      const lines = stream[Symbol.asyncIterator]()
      expect(DEC.decode((await lines.next()).value as Uint8Array)).toBe('{"ts":"1"}\n')
      const idle = lines.next()
      await polled
      const closed = await Promise.race([
        lines.return?.().then(() => 'closed'),
        new Promise((resolve) => {
          setTimeout(() => {
            resolve('stuck')
          }, 500)
        }),
      ])
      expect(closed).toBe('closed')
      expect((await idle).done).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('asks past a stale listing on a fresh stat', async () => {
    // The index holds a listing up to its TTL old: `wc -c` and `cmp -s` take
    // the size from a stat that asks the backend now. Mirrors python's
    // test_a_fresh_stat_asks_past_a_stale_listing.
    const ws = new Workspace({ '/m': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.vfs.write('/m/f', 'grown\n')
      await ws
        .mount('/m')
        .index.setDir(
          '/m',
          [['f', new FileStat({ name: 'f', type: FileType.FILE, size: 3 })]],
          new Date(Date.now() + 3_600_000),
        )
      const listed = (await ws.dispatch('stat', '/m/f')) as FileStat
      const now = (await ws.dispatch('stat', '/m/f', [], { fresh: true })) as FileStat
      expect([listed.size, now.size]).toEqual([3, 6])
      expect(DEC.decode((await ws.shell('wc -c /m/f')).stdout)).toBe('6 /m/f\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps nothing from a natively ranged read', async () => {
    // A store that serves a range itself moved only that range.
    const { ws } = counted(false, '.count')
    await ws.vfs.write('/data/f.txt', '0123456789')
    await ws.cache.remove('/data/f.txt')
    expect(DEC.decode(await ws.vfs.read('/data/f.txt', { offset: 2, size: 3 }))).toBe('234')
    expect(await ws.cache.exists('/data/f.txt')).toBe(false)
  })

  it('keeps nothing when a write races the fetch', async () => {
    // The write lands after the fetch began, so the bytes it read may be
    // older than the file; keeping them would serve the old file. The
    // write keeps its own bytes, which the next read is served.
    const { ws, fetched } = counted(true)
    await ws.vfs.write('/data/f.count', 'STORED')
    await ws.cache.remove('/data/f.count')
    await ws.vfs.read('/data/f.count')
    expect(DEC.decode(await ws.vfs.read('/data/f.count'))).toBe('NEWER')
    expect(fetched).toHaveLength(1)
  })

  it.each([
    ['whole', {}, 'RENDER'],
    ['ranged', { offset: 0, size: 2 }, 'RE'],
  ])(
    'keeps nothing from a renderer registered after the probe (%s)',
    async (_name, window, rendered) => {
      // The fill is chosen after the probe, but the op is resolved only once
      // the mount is ready; a renderer landing in between runs, and its
      // rendering must not become what cat reads, which is the counted read's
      // stored bytes. A ranged read on a store with no native range fills the
      // whole file too.
      const { ws } = counted()
      await ws.vfs.write('/data/f.count', 'STORED')
      await ws.cache.remove('/data/f.count')
      const mount = ws.mount('/data')
      const probe = ws.cache.get.bind(ws.cache)
      const ready = mount.ensureReady.bind(mount)
      let probed = false
      Object.assign(ws.cache, {
        get: async (path: string) => {
          probed = true
          return probe(path)
        },
      })
      Object.assign(mount, {
        ensureReady: async () => {
          if (probed && !('.count' in mount.vfs.renderers)) {
            render(mount.vfs, '.count', () => Promise.resolve(ENC.encode('RENDER')))
          }
          await ready()
        },
      })
      expect(DEC.decode(await ws.vfs.read('/data/f.count', window))).toBe(rendered)
      expect(await ws.cache.exists('/data/f.count')).toBe(false)
      expect(DEC.decode((await ws.shell('cat /data/f.count')).stdout)).toBe('BODY')
    },
  )

  it('hands a ranged render to the renderer as its range', async () => {
    // A render is never kept, so filling the whole file for a range would
    // only render more than the read asked for.
    const { ws } = counted()
    const mount = ws.mount('/data')
    const windows: [unknown, unknown][] = []
    render(mount.vfs, '.count', (_path, _index, offset, size) => {
      windows.push([offset, size])
      return Promise.resolve(ENC.encode('RE'))
    })
    await ws.vfs.write('/data/f.count', 'STORED')
    expect(DEC.decode(await ws.vfs.read('/data/f.count', { offset: 0, size: 2 }))).toBe('RE')
    expect(windows).toEqual([[0, 2]])
  })

  it('neither keeps a render nor serves one to a command', async () => {
    // The file cache holds what commands read under the path alone, so a
    // kept render would be what cat prints, and a kept cat what the
    // renderer read returns.
    const { ws, fetched } = counted(false, '.count')
    await ws.vfs.write('/data/f.count', 'STORED')
    await ws.cache.remove('/data/f.count')
    expect(DEC.decode(await ws.vfs.read('/data/f.count'))).toBe('BODY')
    expect(await ws.cache.exists('/data/f.count')).toBe(false)
    expect(DEC.decode((await ws.shell('cat /data/f.count')).stdout)).toBe('STORED')
    expect(DEC.decode(await ws.vfs.read('/data/f.count', { offset: 0, size: 2 }))).toBe('BO')
    expect(DEC.decode(await ws.vfs.read('/data/f.count'))).toBe('BODY')
    expect(fetched).toEqual(['/data/f.count', '/data/f.count', '/data/f.count'])
  })
})

// An EntryGate that refuses one path and remembers what it was asked.
function refusing(refused: string) {
  const asked: string[] = []
  return {
    asked,
    gate: {
      scoped: true,
      granted: [],
      judged: new Set<string>(),
      check: (virtual: string): void => {
        asked.push(virtual)
        if (virtual === refused) throw new Error(`sealed ${virtual}`)
      },
      scopes: (): boolean => false,
      refusal: (virtual: string): string | null => (virtual === refused ? 'sealed' : null),
    },
  }
}

// A workspace with a linked directory and a link to a file inside it.
async function linkedWs(): Promise<Workspace> {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.shell(
    'mkdir -p /data/real && echo s > /data/real/secret && ' +
      'ln -s /data/real /data/alias && ln -s /data/real/secret /data/flink',
  )
  return ws
}

const text = async (ws: Workspace, virtual: string): Promise<string> =>
  new TextDecoder().decode((await ws.dispatch('read', virtual)) as Uint8Array)

const spec = (virtual: string): PathSpec => PathSpec.fromStrPath(virtual)

// An op a command makes, with its gate: what the command's bound dispatch
// passes.
const byCommand = (
  ws: Workspace,
  gate: EntryGate | null,
  op: string,
  virtual: string,
  args: readonly unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<[unknown, IOResult]> =>
  (ws as unknown as { dispatcher: { dispatch: CallerDispatchFn } }).dispatcher.dispatch(
    op,
    spec(virtual),
    args,
    kwargs,
    undefined,
    { ...currentCaller(), ruleGate: gate },
  )

describe("a command's own op is judged on the paths the dispatcher reaches", () => {
  // Each spelling once, in the order the dispatcher meets it: as handed in,
  // walked, then followed. A refused op leaves the bytes alone; one the
  // command did not make is the dispatcher's alone.
  it('judges every spelling once', async () => {
    const ws = await linkedWs()
    try {
      await ws.shell(
        'echo new > /data/real/other && echo o > /data/other && ' +
          'ln -s /data/other /data/real/flink2',
      )
      const { gate, asked } = refusing('/data/real/secret')
      for (const [op, virtual, args, kwargs] of [
        ['unlink', '/data/alias/secret', [], {}],
        ['rename', '/data/real/other', [spec('/data/alias/secret')], {}],
        ['read', '/data/flink', [], {}],
        ['write', '/data/alias/secret', [new TextEncoder().encode('x\n')], { nofollow: true }],
      ] as const) {
        await expect(byCommand(ws, gate, op, virtual, args, kwargs)).rejects.toThrow('sealed')
      }
      expect(asked).toEqual([
        '/data/alias/secret',
        '/data/real/secret',
        '/data/real/other',
        '/data/alias/secret',
        '/data/real/secret',
        '/data/flink',
        '/data/real/secret',
        '/data/alias/secret',
        '/data/real/secret',
      ])
      expect(await text(ws, '/data/real/secret')).toBe('s\n')
      expect(await text(ws, '/data/real/other')).toBe('new\n')
      const walked = refusing('/data/real/flink2')
      await expect(byCommand(ws, walked.gate, 'read', '/data/alias/flink2')).rejects.toThrow(
        'sealed',
      )
      expect(walked.asked).toEqual(['/data/alias/flink2', '/data/real/flink2'])
      await ws.dispatch('unlink', '/data/alias/secret')
      await expect(text(ws, '/data/real/secret')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ws.close()
    }
  })

  // The link table answers unlink of a link: a rule on the link name holds
  // before that answer, and one on the referent is never asked.
  it('judges a link removal on the link entry', async () => {
    const ws = await linkedWs()
    try {
      await expect(
        byCommand(ws, refusing('/data/flink').gate, 'unlink', '/data/flink'),
      ).rejects.toThrow('sealed')
      const referent = refusing('/data/real/secret')
      await byCommand(ws, referent.gate, 'unlink', '/data/flink')
      expect(referent.asked).toEqual(['/data/flink'])
      expect(await text(ws, '/data/real/secret')).toBe('s\n')
    } finally {
      await ws.close()
    }
  })

  // A write into hidden space, a link there, a hidden rename endpoint and
  // one behind a linked parent are missing, and the gate is never asked.
  it('answers hidden space before any rule', async () => {
    const ws = await linkedWs()
    try {
      await ws.shell(
        'mkdir -p /data/hid && echo h > /data/hid/h && ' +
          'ln -s /data/hid /data/halias && ln -s /data/hid/h /data/hlink',
      )
      const session = new SessionState({
        sessionId: 'hider',
        visibility: { paths: { paths: ['/data/hid'] } },
      })
      const { gate, asked } = refusing('/data/real/secret')
      await runWithSession(session, async () => {
        for (const [op, virtual, args] of [
          ['write', '/data/hid/x', [new TextEncoder().encode('x\n')]],
          ['read', '/data/hlink', []],
          ['rename', '/data/real/secret', [spec('/data/hid/x')]],
          ['rename', '/data/hid/h', [spec('/data/real/moved')]],
          ['rename', '/data/real/secret', [spec('/data/halias/x')]],
        ] as const) {
          await expect(byCommand(ws, gate, op, virtual, args)).rejects.toMatchObject({
            code: 'ENOENT',
          })
        }
      })
      expect(asked).toEqual([])
    } finally {
      await ws.close()
    }
  })

  // The mount's op sees only its own arguments, whoever made the call. A
  // call with no gate is the dispatcher's alone, as Python's rule_gate=None.
  it('never forwards the caller to the op', async () => {
    const ws = await linkedWs()
    const spy = vi.spyOn(MountEntry.prototype, 'callKeyed')
    try {
      const { gate, asked } = refusing('/nothing')
      await byCommand(ws, gate, 'read', '/data/real/secret')
      const seen = spy.mock.calls.map((call) => call[3])
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((kw) => kw === undefined || !('ruleGate' in kw))).toBe(true)
      expect(asked).toEqual(['/data/real/secret'])
      const [read] = await byCommand(ws, null, 'read', '/data/real/secret')
      expect(new TextDecoder().decode(read as Uint8Array)).toBe('s\n')
    } finally {
      spy.mockRestore()
      await ws.close()
    }
  })
})

/**
 * A RAM store that keeps its listings and copies a tree in one op, as
 * OneDrive's server-side copy does. Mirrors Python's `TreeCopyRAM`.
 */
class TreeCopyRAM extends RAMVFS {
  override readonly indexTtl: number = 60
  override readonly local: boolean = false

  override dirCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    const base = '/' + stripSlash(src.vfsPath)
    const landing = '/' + stripSlash(dst.vfsPath)
    for (const name of [...this.store.dirs]) {
      if (name.startsWith(base + '/')) this.store.dirs.add(landing + name.slice(base.length))
    }
    for (const [name, data] of [...this.store.files]) {
      if (name.startsWith(base + '/')) this.store.files.set(landing + name.slice(base.length), data)
    }
    return Promise.resolve()
  }
}

/**
 * A RAM mount that answers pwrite the way S3 and redis do: read the file,
 * give the loop a turn, and write the whole file back.
 */
class SplicingRAMVFS extends RAMVFS {
  override async pwrite(path: PathSpec, data: Uint8Array, offset: number): Promise<void> {
    const whole = await materialize(await this.read(path))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await this.write(path, spliceWindow(whole, offset, data))
  }
}

describe('dispatch runs writers to one path one at a time', () => {
  it('lands every offset write on a store that splices', async () => {
    // Four sessions' edits at once: each pwrite reads the file before any
    // writes it back, so without one writer at a time per path every
    // write puts back three bytes the others had just replaced. Mirrors
    // python's test_offset_writes_to_one_path_all_land_on_a_splicing_store.
    const ws = new Workspace({ '/data': new SplicingRAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.dispatch('write', '/data/f', [ENC.encode('0123456789')])
      await Promise.all(
        (
          [
            ['A', 0],
            ['B', 3],
            ['C', 6],
            ['D', 9],
          ] as const
        ).map(([letter, offset]) => ws.dispatch('pwrite', '/data/f', [ENC.encode(letter), offset])),
      )
      expect(DEC.decode((await ws.dispatch('read', '/data/f')) as Uint8Array)).toBe('A12B45C78D')
    } finally {
      await ws.close()
    }
  })

  it('holds one store mounted twice as one file', async () => {
    // The same store under two names: one writer at a time by the store's
    // own key, not by the name. Mirrors python's
    // test_offset_writes_through_two_mounts_of_one_store_all_land.
    const store = new SplicingRAMVFS()
    const ws = new Workspace({ '/a': store, '/b': store }, { mode: MountMode.WRITE })
    try {
      await ws.dispatch('write', '/a/f', [ENC.encode('0123456789')])
      await Promise.all(
        (
          [
            ['/a/f', 'A', 0],
            ['/b/f', 'B', 3],
            ['/a/f', 'C', 6],
            ['/b/f', 'D', 9],
          ] as const
        ).map(([name, letter, offset]) =>
          ws.dispatch('pwrite', name, [ENC.encode(letter), offset]),
        ),
      )
      expect(DEC.decode((await ws.dispatch('read', '/b/f')) as Uint8Array)).toBe('A12B45C78D')
    } finally {
      await ws.close()
    }
  })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A cached store whose stream hands out 10-byte chunks, counting each one
 * the backend delivered. Mirrors Python's Tape. */
class Tape extends BaseVFS {
  override readonly name: string = 'tape'
  override readonly cachesReads: boolean = true
  readonly files = new Map<string, Uint8Array>([['a.txt', ENC.encode('0123456789'.repeat(5))]])
  delay = 0
  pulled = 0
  reads = 0
  closed = false

  override readdir(): Promise<FileStat[]> {
    return Promise.resolve(
      [...this.files.entries()].map(
        ([name, data]) => new FileStat({ name, type: FileType.FILE, size: data.byteLength }),
      ),
    )
  }

  override stat(path: PathSpec): Promise<FileStat> {
    const key = path.vfsPath.replace(/^\/+/, '')
    if (key === '') return Promise.resolve(new FileStat({ name: '/', type: FileType.DIRECTORY }))
    const data = this.files.get(key)
    if (data === undefined) return Promise.reject(enoent(path))
    return Promise.resolve(new FileStat({ name: key, type: FileType.FILE, size: data.byteLength }))
  }

  override read(path: PathSpec): Promise<ByteSource> {
    this.reads += 1
    const data = this.files.get(path.vfsPath.replace(/^\/+/, ''))
    if (data === undefined) return Promise.reject(enoent(path))
    return Promise.resolve(this.chunksOf(data))
  }

  override async write(path: PathSpec, data: ByteSource): Promise<void> {
    this.files.set(path.vfsPath.replace(/^\/+/, ''), await materialize(data))
  }

  private async *chunksOf(data: Uint8Array): AsyncIterable<Uint8Array> {
    try {
      for (let at = 0; at < data.byteLength; at += 10) {
        await sleep(this.delay)
        this.pulled += 1
        yield data.subarray(at, at + 10)
      }
    } finally {
      this.closed = true
    }
  }
}

class ReadsResults implements Policy {
  postVfs(_ctx: VfsResultContext): Action | null {
    return null
  }
}

const TAPE = '/tape/a.txt'
const WHOLE = '0123456789'.repeat(5)

async function pullAll(stream: unknown): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(DEC.decode(chunk))
  return chunks
}

describe('a streamed read', () => {
  it('arrives as it is pulled and fills the cache', async () => {
    const tape = new Tape()
    const ws = new Workspace({ '/tape': tape }, { mode: MountMode.WRITE })
    try {
      const stream = await ws.dispatch('read', TAPE, [], { stream: true })
      expect(tape.pulled).toBe(1)
      expect(await pullAll(stream)).toEqual(Array<string>(5).fill('0123456789'))
      expect(DEC.decode((await ws.dispatch('read', TAPE)) as Uint8Array)).toBe(WHOLE)
      expect(tape.reads).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('fails at the call', async () => {
    const ws = new Workspace({ '/tape': new Tape() }, { mode: MountMode.WRITE })
    try {
      await expect(
        ws.dispatch('read', '/tape/missing.txt', [], { stream: true }),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ws.close()
    }
  })

  it.each([
    [[], { offset: 5 }],
    [[], { size: 4 }],
    [[new ReadsResults()], {}],
  ])('with policies %o and window %o is answered whole', async (policies, window) => {
    const tape = new Tape()
    const ws = new Workspace({ '/tape': tape }, { mode: MountMode.WRITE, policies })
    try {
      const got = await ws.dispatch('read', TAPE, [], { ...window, stream: true })
      expect(got).toBeInstanceOf(Uint8Array)
      expect(tape.reads).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it.each([OnExceed.TRUNCATE, OnExceed.ERROR])(
    'is never cut by a mount read entry (%s)',
    async (onExceed) => {
      const tape = new Tape()
      const ws = new Workspace(
        { '/tape': [tape, MountMode.WRITE, { read: new Limit({ maxBytes: 15, onExceed }) }] },
        { mode: MountMode.WRITE },
      )
      try {
        const stream = await ws.dispatch('read', TAPE, [], { stream: true, filetype: null })
        expect((await pullAll(stream)).join('')).toBe('0123456789'.repeat(5))
        expect(tape.pulled).toBe(5)
      } finally {
        await ws.close()
      }
    },
  )

  it('closes and keeps nothing when closed before its first pull', async () => {
    const tape = new Tape()
    const ws = new Workspace({ '/tape': tape }, { mode: MountMode.WRITE })
    try {
      const stream = (await ws.dispatch('read', TAPE, [], {
        stream: true,
      })) as AsyncGenerator<Uint8Array>
      await stream.return(undefined)
      expect([tape.pulled, tape.closed]).toEqual([1, true])
      await ws.dispatch('read', TAPE)
      expect(tape.reads).toBe(2)
    } finally {
      await ws.close()
    }
  })

  it('keeps none of itself when a write lands during it', async () => {
    const tape = new Tape()
    const ws = new Workspace({ '/tape': tape }, { mode: MountMode.WRITE })
    try {
      const stream = await ws.dispatch('read', TAPE, [], { stream: true })
      await ws.dispatch('write', TAPE, [ENC.encode('new')])
      expect((await pullAll(stream))[0]).toBe('0123456789')
      expect(DEC.decode((await ws.dispatch('read', TAPE)) as Uint8Array)).toBe('new')
      expect(tape.reads).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('keeps nothing past the drain budget', async () => {
    const tape = new Tape()
    const ws = new Workspace({ '/tape': tape }, { mode: MountMode.WRITE })
    try {
      ws.cache.maxDrainBytes = 20
      const stream = await ws.dispatch('read', TAPE, [], { stream: true })
      expect((await pullAll(stream)).join('')).toBe(WHOLE)
      await ws.dispatch('read', TAPE)
      expect(tape.reads).toBe(2)
    } finally {
      await ws.close()
    }
  })
})

class LostReply extends Tape {
  // A store whose write lands and whose reply then breaks off.
  override async write(path: PathSpec, data: ByteSource): Promise<void> {
    this.files.set(path.vfsPath.replace(/^\/+/, ''), await materialize(data))
    throw new Error('reply lost')
  }
}

describe('a write and the cached bytes', () => {
  it('a write that throws still drops the cached bytes', async () => {
    // The store may hold the new bytes though the write threw, so the copy
    // cached before it is not served again.
    const tape = new LostReply()
    const ws = new Workspace({ '/tape': tape }, { mode: MountMode.WRITE })
    try {
      await ws.dispatch('read', TAPE)
      await expect(ws.dispatch('write', TAPE, [ENC.encode('new')])).rejects.toThrow('reply lost')
      const got = (await ws.dispatch('read', TAPE)) as Uint8Array
      expect([DEC.decode(got), tape.reads]).toEqual(['new', 2])
    } finally {
      await ws.close()
    }
  })

  it('a path the line retracted is not served from the cache', async () => {
    // A copy still running has recorded that it replaced the path, but the
    // dispatcher evicts only once the copy ends.
    const tape = new Tape()
    const ws = new Workspace({ '/tape': tape }, { mode: MountMode.WRITE })
    try {
      await ws.dispatch('read', TAPE)
      await runWithRecording(async () => {
        record('copy', TAPE, 'tape', 0, startOp())
        await ws.dispatch('read', TAPE)
      })
      expect(tape.reads).toBe(2)
    } finally {
      await ws.close()
    }
  })
})

describe('a link at the final name', () => {
  function linked(mounts: Record<string, RAMVFS>): Workspace {
    return new Workspace(mounts, {
      mode: MountMode.WRITE,
    })
  }

  it('a subtree read names the links on its own mount', async () => {
    // No backend stores a link, so the walk a subtree read stands in for
    // meets them only here; one below a nested mount is that mount's.
    const ws = linked({ '/base/': new RAMVFS(), '/base/inner/': new RAMVFS() })
    try {
      await ws.shell('echo hi > /base/f.txt')
      await ws.shell('ln -s /base/f.txt /base/kept')
      await ws.shell('ln -s /base/f.txt /base/inner/lnk')
      const tree = (await ws.dispatch('read_tree', '/base', [], { nofollow: true })) as Map<
        string,
        FileStat
      >
      expect([...tree.keys()].sort()).toEqual(['f.txt', 'kept'])
      expect(tree.get('kept')?.type).toBe(FileType.SYMLINK)
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_subtree_read_answers_a_link_over_what_the_backend_holds.
  it('a subtree read answers a link over what the backend holds', async () => {
    // A writer past mirage can put a key where a link stands; a stat of the
    // name answers the link, so the subtree read answers it too.
    const ram = new RAMVFS()
    const ws = linked({ '/base/': ram })
    try {
      await ws.shell('echo hi > /base/f.txt')
      await ws.shell('ln -s /base/f.txt /base/d')
      ram.store.dirs.add('/d')
      ram.store.files.set('/d/x', new TextEncoder().encode('x'))
      const tree = (await ws.dispatch('read_tree', '/base', [], { nofollow: true })) as Map<
        string,
        FileStat
      >
      const row = (await ws.dispatch('stat', '/base/d', [], { nofollow: true })) as FileStat
      expect([...tree.keys()].sort()).toEqual(['d', 'f.txt'])
      expect([tree.get('d')?.type, row.type]).toEqual([FileType.SYMLINK, FileType.SYMLINK])
    } finally {
      await ws.close()
    }
  })

  it('a listing that does not follow stops at a link', async () => {
    // As open(2) answers a link with O_DIRECTORY | O_NOFOLLOW. A listing
    // that follows names the children under the link it was handed.
    const ws = linked({ '/data/': new RAMVFS() })
    try {
      await ws.shell('mkdir /data/d && echo hi > /data/d/f.txt')
      await ws.shell('ln -s /data/d /data/dlink')
      await expect(
        ws.dispatch('readdir', '/data/dlink', [], { nofollow: true }),
      ).rejects.toMatchObject({ code: 'ENOTDIR' })
      expect(await ws.dispatch('readdir', '/data/dlink')).toEqual(['/data/dlink/f.txt'])
      // A caller that already followed the link hands the directory it
      // reached, its typed spelling riding along, and lists that one.
      const reached = new PathSpec({
        virtual: '/data/d',
        directory: '/data/',
        vfsPath: 'd',
        rawPath: '/data/dlink/',
        dotted: '/data/dlink/',
      })
      const dispatcher = (ws as unknown as { dispatcher: { dispatch: CallerDispatchFn } })
        .dispatcher
      const [listed] = await dispatcher.dispatch('readdir', reached)
      expect(listed).toEqual(['/data/d/f.txt'])
    } finally {
      await ws.close()
    }
  })

  it('a stat after the command’s probe is the probe’s answer', async () => {
    // Under read: fresh the probe already asked the backend about the
    // command's operand. The stat after it is that answer, stamped as any
    // stat is; a write in the command sends the next one to the backend.
    const ws = linked({ '/data/': new RAMVFS() })
    try {
      await ws.shell('echo hello > /data/a.txt')
      const spec = PathSpec.fromStrPath('/data/a.txt')
      const manager = ws.namespace.mountFor('/data/a.txt').cacheManager
      if (manager === null) throw new Error('no cache manager')
      await runInCommandScope(async () => {
        manager.noteProbed(spec, new FileStat({ name: 'a.txt', size: 9, type: FileType.FILE }))
        const probed = (await ws.dispatch('stat', '/data/a.txt')) as FileStat
        expect([probed.size, probed.dev]).toEqual([9, ident('/data/')])
        await ws.dispatch('write', '/data/a.txt', [ENC.encode('hi')])
        expect(((await ws.dispatch('stat', '/data/a.txt')) as FileStat).size).toBe(2)
      })
    } finally {
      await ws.close()
    }
  })

  it('a stat names the device of the mount serving it', async () => {
    // The id a runtime reports as st_dev: one per mount, the namespace's
    // own for a directory no mount serves, and a link's is its mount's.
    const ws = linked({
      '/base/': new RAMVFS(),
      '/base/inner/': new RAMVFS(),
      '/far/deep/': new RAMVFS(),
    })
    try {
      await ws.shell('echo hi > /base/f.txt')
      await ws.shell('ln -s /base/inner /base/lnk')
      const dev = async (path: string, nofollow = false): Promise<number | null> =>
        ((await ws.dispatch('stat', path, [], nofollow ? { nofollow } : {})) as FileStat).dev
      expect(await dev('/base/f.txt')).toBe(ident('/base/'))
      expect(await dev('/base')).toBe(ident('/base/'))
      expect(await dev('/base/inner')).toBe(ident('/base/inner/'))
      expect(await dev('/far')).toBe(ident('/'))
      expect(await dev('/base/lnk', true)).toBe(ident('/base/'))
      expect(await dev('/base/lnk')).toBe(ident('/base/inner/'))
      const tree = (await ws.dispatch('read_tree', '/base', [], { nofollow: true })) as Map<
        string,
        FileStat
      >
      expect(new Set([...tree.values()].map((row) => row.dev))).toEqual(new Set([ident('/base/')]))
    } finally {
      await ws.close()
    }
  })
})

describe('a command reads at the dispatcher', () => {
  it.each([
    'cat /d/a.txt',
    'head -n 1 /d/a.txt',
    'tail -n 1 /d/a.txt',
    'wc -l /d/a.txt',
    'grep a /d/a.txt',
    'rg a /d/a.txt',
    'sort /d/a.txt',
    'md5sum /d/a.txt',
  ])('%s', async (line) => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.vfs.write('/d/a.txt', 'a\nb\n')
      const seen = dispatched(ws)
      const out = await ws.shell(line)
      expect(out.exitCode).toBe(0)
      expect(seen).toContainEqual(['read', '/d/a.txt'])
    } finally {
      await ws.close()
    }
  })
})

class UnsizedRAM extends RAMVFS {
  override readonly cachesReads = true

  override async stat(path: PathSpec): Promise<FileStat> {
    return (await super.stat(path)).with({ size: null })
  }
}

describe('a stat with no size', () => {
  it('does not probe cached bytes for a directory', async () => {
    const vfs = new UnsizedRAM()
    vfs.store.dirs.add('/')
    vfs.store.dirs.add('/d')
    const ws = new Workspace({ '/api': vfs })
    try {
      await ws.cache.set('/api/d', ENC.encode('not a file'))
      const get = vi.spyOn(ws.cache, 'get')
      const row = await ws.vfs.stat('/api/d')
      expect([row.type, row.size]).toEqual([FileType.DIRECTORY, null])
      expect(get.mock.calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('takes the cached length once a read kept the bytes', async () => {
    // An API mount cannot size a file without fetching it; once a read kept
    // its bytes, every caller of the dispatcher sees their length.
    const vfs = new UnsizedRAM()
    vfs.store.dirs.add('/')
    vfs.store.files.set('/f', new TextEncoder().encode('hello\n'))
    const ws = new Workspace({ '/api': vfs }, { mode: MountMode.WRITE })
    try {
      expect((await ws.vfs.stat('/api/f')).size).toBeNull()
      await ws.vfs.read('/api/f')
      expect((await ws.vfs.stat('/api/f')).size).toBe('hello\n'.length)
    } finally {
      await ws.close()
    }
  })
})

// A RAM store that answers a read of a path in `voiced` in another store's
// voice: an error of its own, or no bytes.
class DirVoiceRAM extends RAMVFS {
  constructor(
    readonly voice: ((virtual: string) => Error) | Uint8Array,
    readonly voiced: ReadonlySet<string>,
  ) {
    super()
  }

  answer(path: PathSpec): Uint8Array {
    if (this.voice instanceof Uint8Array) return this.voice
    throw this.voice(path.virtual)
  }

  override async read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
    signal?: AbortSignal,
  ): Promise<ByteSource> {
    if (this.voiced.has(path.mountPath)) return this.answer(path)
    return super.read(path, handed, offset, size, signal)
  }
}

// A store whose backend fails for a path in `voiced`, on a stat as on a read.
class UpstreamFailingRAM extends DirVoiceRAM {
  override stat(path: PathSpec): Promise<FileStat> {
    if (this.voiced.has(path.mountPath)) return Promise.reject(upstream(path.virtual))
    return super.stat(path)
  }
}

const upstream = (virtual: string): Error =>
  Object.assign(new Error(`upstream 502 Bad Gateway: ${virtual}`), { code: 'EIO' })

const hostNamed = (virtual: string): Error =>
  Object.assign(new Error('Is a directory'), { code: 'EISDIR', path: `/host${virtual}` })

async function drained(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += DEC.decode(chunk)
  return text
}

/** The code a read is refused with, null when it answers. */
function refusalCode(read: Promise<unknown>): Promise<string | null | undefined> {
  return read.then(
    () => null,
    (err: unknown) => (err as { code?: string }).code,
  )
}

const WS_READS: [string, (ws: Workspace, path: string) => Promise<string>][] = [
  ['whole', async (ws, path) => DEC.decode(await ws.vfs.read(path))],
  ['ranged', async (ws, path) => DEC.decode(await ws.vfs.read(path, { offset: 0, size: 4 }))],
  ['streamed', async (ws, path) => drained(await ws.vfs.read(path, { stream: true }))],
]

describe('a read of a hidden link', () => {
  it('keeps a hidden link to a directory missing', async () => {
    // The probe walks no further than the caller sees: a hidden link to a
    // visible directory answers as a missing name, never as the directory
    // its target is.
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/')
    vfs.store.files.set('/sub/x', ENC.encode('x'))
    const ws = new Workspace({ '/m': vfs }, { mode: MountMode.WRITE })
    try {
      await ws.shell('ln -s /m/sub /m/alias')
      ws.createSession('agent', { profile: { paths: { hide: ['/m/alias'] } } })
      const agent = ws.vfs.forSession('agent')
      expect(await refusalCode(agent.read('/m/alias'))).toBe('ENOENT')
      expect(await refusalCode(agent.read('/m/alias', { stream: true }).then(drained))).toBe(
        'ENOENT',
      )
      const io = await ws.shell('cat /m/alias', { sessionId: 'agent' })
      expect(DEC.decode(io.stderr)).toBe('cat: /m/alias: No such file or directory\n')
      expect(await refusalCode(ws.vfs.read('/m/alias'))).toBe('EISDIR')
    } finally {
      await ws.close()
    }
  })
})

describe.each(WS_READS)('a %s read through ws.vfs', (_, read) => {
  // A store answers a read of a directory in its own voice (a keyed store's
  // ENOENT, sftp's opaque error, no bytes); ws.vfs gets GNU's EISDIR at the
  // path it named, as a command does, and any other failure as it was.
  it.each([
    ['an implicit directory', null, [], { '/sub/x': 'x' }, '/m/sub', 'EISDIR'],
    ['an opaque directory read', () => new Error('SFTP'), ['/d'], {}, '/m/d', 'EISDIR'],
    ['a host-named directory', hostNamed, ['/d'], {}, '/m/d', 'EISDIR'],
    ['a directory read empty', new Uint8Array(), ['/d'], {}, '/m/d', 'EISDIR'],
    ['an unrelated failure', (v: string) => eacces(v), [], { '/f': 'x' }, '/m/f', 'EACCES'],
  ] as [string, DirVoiceRAM['voice'] | null, string[], Record<string, string>, string, string][])(
    'answers %s with its own code at the path',
    async (_, voice, dirs, files, path, code) => {
      const vfs = voice === null ? new RAMVFS() : new DirVoiceRAM(voice, new Set([...dirs, '/f']))
      vfs.store.dirs.add('/')
      for (const dir of dirs) vfs.store.dirs.add(dir)
      for (const [name, text] of Object.entries(files)) vfs.store.files.set(name, ENC.encode(text))
      const ws = new Workspace({ '/m': vfs })
      try {
        const refused = await read(ws, path).then(
          () => null,
          (err: unknown) => err as { code?: string; message?: string },
        )
        expect(refused?.code).toBe(code)
        expect(refused?.message).toContain(path)
        expect(refused?.message).not.toContain('/host')
      } finally {
        await ws.close()
      }
    },
  )

  it("gives a read through a link its target's kind", async () => {
    // GNU's cat calls a link to a directory a directory, at the name it was
    // given; a link that leads nowhere stays absent, though its parent lists
    // its name.
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/')
    vfs.store.files.set('/sub/x', ENC.encode('x'))
    const ws = new Workspace({ '/m': vfs }, { mode: MountMode.WRITE })
    try {
      await ws.shell('ln -s /m/sub /m/alias; ln -s /m/nope /m/gone')
      const refused = (p: string) =>
        read(ws, p).then(
          () => null,
          (err: unknown) => err as { code?: string; message?: string },
        )
      const alias = await refused('/m/alias')
      expect(alias?.code).toBe('EISDIR')
      expect(alias?.message).toContain('/m/alias')
      expect((await refused('/m/gone'))?.code).toBe('ENOENT')
    } finally {
      await ws.close()
    }
  })

  it('keeps the error of a file whose backend fails', async () => {
    // The directory probe's stat fails too, which proves nothing; the
    // parent's listing names the file, so reading past that stat called it
    // a directory.
    const vfs = new UpstreamFailingRAM(upstream, new Set(['/f']))
    vfs.store.dirs.add('/')
    vfs.store.files.set('/f', ENC.encode('x'))
    const ws = new Workspace({ '/m': vfs })
    try {
      const refused = await read(ws, '/m/f').then(
        () => null,
        (err: unknown) => err as { code?: string },
      )
      expect(refused?.code).toBe('EIO')
    } finally {
      await ws.close()
    }
  })

  it('reads a file, empty or not', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/')
    vfs.store.files.set('/f', ENC.encode('data'))
    vfs.store.files.set('/empty', new Uint8Array())
    const ws = new Workspace({ '/m': vfs })
    try {
      expect(await read(ws, '/m/f')).toBe('data')
      expect(await read(ws, '/m/empty')).toBe('')
    } finally {
      await ws.close()
    }
  })
})

describe('a write to a slash-terminated name', () => {
  it.each([
    ['/m/missing/', 'EISDIR'],
    ['/m/d/f/', 'EISDIR'],
    ['/m/d/', 'EISDIR'],
    ['/m/d/./', 'EISDIR'],
    ['/m/d/f/./', 'ENOTDIR'],
    ['/m/missing/./', 'ENOENT'],
  ])('is refused through ws.vfs for %s', async (path, code) => {
    // `x/` names a directory, so ws.vfs refuses to create a file there
    // before anything is looked up, as the shell's tee and truncate do.
    // Behind a dot the walk through it answers first, as GNU's does.
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/')
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/f', ENC.encode('x'))
    const ws = new Workspace({ '/m': vfs }, { mode: MountMode.WRITE })
    try {
      for (const write of [
        () => ws.vfs.write(path, 'y'),
        () => ws.vfs.append(path, ENC.encode('y')),
        () => ws.vfs.pwrite(path, ENC.encode('y'), 0),
        () => ws.vfs.truncate(path, 0),
      ]) {
        await expect(write()).rejects.toMatchObject({ code })
      }
      expect([...vfs.store.files.keys()]).toEqual(['/d/f'])
    } finally {
      await ws.close()
    }
  })
})

// A caching RAM mount that answers the read stand-ins itself.
class StandInRAM extends RAMVFS {
  override readonly cachesReads = true
  readonly asked: string[] = []

  override firstLines(_path: PathSpec, _n: number, _handed?: Handed): Promise<Uint8Array> {
    this.asked.push('first_lines')
    return Promise.resolve(ENC.encode('stand-in\n'))
  }

  override lineCount(_path: PathSpec, _handed?: Handed): Promise<number> {
    this.asked.push('line_count')
    return Promise.resolve(7)
  }
}

function standIns(): [StandInRAM, Workspace] {
  const vfs = new StandInRAM()
  vfs.store.dirs.add('/')
  vfs.store.files.set('/cold', ENC.encode('a\n'))
  vfs.store.files.set('/warm', ENC.encode('b\n'))
  return [vfs, new Workspace({ '/m': vfs })]
}

describe('the cache stage', () => {
  it('has a stand-in give way to the read for a cached file', async () => {
    // A call standing in for a read answers null for a file the read cache
    // holds, so ws.vfs reads it and is served the cached copy.
    const [vfs, ws] = standIns()
    try {
      await ws.vfs.read('/m/warm')
      for (const [name, args] of [
        ['first_lines', [1]],
        ['line_count', []],
      ] as [string, unknown[]][]) {
        const [cold] = await ws.vfs.dispatch(name, '/m/cold', args)
        const [warm] = await ws.vfs.dispatch(name, '/m/warm', args)
        expect(cold).not.toBeNull()
        expect(warm).toBeNull()
      }
      expect(vfs.asked).toEqual(['first_lines', 'line_count'])
    } finally {
      await ws.close()
    }
  })

  it('answers a warm read with whether a copy is held', async () => {
    // Presence only: a held copy is never fetched to answer, since every
    // caller then reads the file anyway (wc -c, grep's narrowing).
    const [vfs, ws] = standIns()
    try {
      await ws.vfs.read('/m/warm')
      vfs.store.files.set('/warm', ENC.encode('changed\n'))
      const reads = vi.spyOn(vfs, 'read')
      const fetched = vi.spyOn(ws.cache, 'get')
      const [cold] = await ws.vfs.dispatch('read', '/m/cold', [], { warm: true })
      const [warm] = await ws.vfs.dispatch('read', '/m/warm', [], { warm: true })
      expect(cold).toBeNull()
      expect(warm).toBe(true)
      expect(reads.mock.calls).toEqual([])
      expect(fetched.mock.calls).toEqual([])
    } finally {
      await ws.close()
    }
  })
})

describe('a whole write keeps its bytes', () => {
  it('as a copy, so the caller can reuse its buffer', async () => {
    class Kept extends RAMVFS {
      override readonly cachesReads = true
    }
    const ws = new Workspace({ '/r': new Kept() }, { mode: MountMode.WRITE })
    try {
      const data = new TextEncoder().encode('sent')
      await ws.vfs.write('/r/f', data)
      data.fill(0)
      expect(await ws.cache.get('/r/f')).toEqual(new TextEncoder().encode('sent'))
    } finally {
      await ws.close()
    }
  })
})

// A RAM mount whose searches answer every file it holds and whose walk guard
// keeps the count it is handed. Twin of Python's SearchedRAM.
class SearchedRAM extends RAMVFS {
  readonly counted: (number | null)[] = []
  readonly batches: string[][] = []

  override filesContaining(path: PathSpec): Promise<PathSpec[] | null> {
    return Promise.resolve([...this.store.files.keys()].map((key) => mountedPath(path, key)))
  }

  override search(path: PathSpec): Promise<[string, string][] | null> {
    return Promise.resolve(
      [...this.store.files.keys()].map((key): [string, string] => {
        const hit = mountedPath(path, key).virtual
        return [hit, `${hit}\nabout ${key}`]
      }),
    )
  }

  override searchMany(paths: PathSpec[]): Promise<[string, string][] | null> {
    this.batches.push(paths.map((path) => path.virtual))
    const [first] = paths
    return first === undefined ? Promise.resolve([]) : this.search(first)
  }

  override beforeFullWalk(_path: PathSpec, files: number | null): Promise<void> {
    this.counted.push(files)
    return Promise.resolve()
  }
}

// A RAM mount with no walk guard that counts its tree reads. Twin of
// Python's TreeCountingRAM.
class TreeCountingRAM extends RAMVFS {
  trees = 0
  override walkLimit = -1

  override readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    this.trees += 1
    return super.readTree(path)
  }
}

// A RAM mount held to a `walkLimit` with no guard of its own. Twin of
// Python's LimitedRAM.
class LimitedRAM extends RAMVFS {
  override walkLimit = 2
}

// The same mount with no tree read, so a walk is counted by listing each
// directory. Twin of Python's ListedRAM.
class ListedRAM extends LimitedRAM {
  readonly listed: string[] = []

  override readdir(path: PathSpec): Promise<FileStat[]> {
    this.listed.push(path.virtual)
    return super.readdir(path)
  }
}
Object.defineProperty(ListedRAM.prototype, 'readTree', {
  value: (BaseVFS.prototype as unknown as Record<string, unknown>).readTree,
})

// A RAM mount whose listing stops at a walk's limit. Twin of Python's CutRAM.
class CutRAM extends RAMVFS {
  readonly asked: (number | undefined)[] = []

  constructor() {
    super()
    this.store.dirs.add('/d')
    for (const name of ['a', 'b', 'sec']) this.store.files.set(`/d/${name}`, new Uint8Array())
  }
}
// RAMVFS narrows readdir to a plain array, so the cut listing goes on the
// prototype.
Object.defineProperty(CutRAM.prototype, 'readdir', {
  value: async function (this: CutRAM, path: PathSpec, handed?: Handed) {
    const limit = handed?.limit
    this.asked.push(limit)
    const rows = await RAMVFS.prototype.readdir.call(this, path)
    if (limit === undefined || rows.length < limit) return rows
    return new DirListing({ entries: rows.slice(0, limit), partial: true })
  },
})

// The limited mount handing each file's matching lines over itself. Twin of
// Python's LinedRAM.
class LinedRAM extends LimitedRAM {
  readonly asked: string[] = []

  override async linesContaining(path: PathSpec, text: string): Promise<ByteSource | null> {
    this.asked.push(path.virtual)
    const data = new TextDecoder().decode(await materialize(await this.read(path)))
    const lines = data.split(/(?<=\n)/).filter((line) => line.includes(text))
    return new TextEncoder().encode(lines.join(''))
  }
}

function limited<T extends RAMVFS>(cls: new () => T, files: number): T {
  const vfs = new cls()
  vfs.store.dirs.add('/d')
  vfs.store.dirs.add('/d/secret')
  vfs.store.files.set('/d/secret/b.txt', new TextEncoder().encode('b\n'))
  for (let i = 0; i < files - 1; i++) {
    vfs.store.files.set(`/d/a${String(i)}.txt`, new TextEncoder().encode('a\n'))
  }
  return vfs
}

function searched(): SearchedRAM {
  const vfs = new SearchedRAM()
  vfs.store.dirs.add('/d')
  vfs.store.dirs.add('/d/secret')
  vfs.store.files.set('/d/a.txt', new TextEncoder().encode('a\n'))
  vfs.store.files.set('/d/secret/b.txt', new TextEncoder().encode('b\n'))
  return vfs
}

function secretHidden(): SessionState {
  return new SessionState({
    sessionId: 'agent',
    visibility: { paths: { paths: ['/ram/d/secret'] } },
  })
}

describe('a hide filters a one-call read', () => {
  // Twin of test_a_hide_filters_a_tree_read_instead_of_declining.
  it('answers a tree read without the hidden entries', async () => {
    const ws = new Workspace({ '/ram': searched() })
    try {
      const found = await runWithSession(secretHidden(), () => ws.dispatch('read_tree', '/ram/d'))
      expect([...(found as Map<string, FileStat>).keys()]).toEqual(['a.txt'])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_hide_drops_its_files_from_a_search.
  it('drops the hidden files from a search', async () => {
    const vfs = searched()
    const ws = new Workspace({ '/ram': vfs })
    try {
      await runWithSession(secretHidden(), async () => {
        const hits = (await ws.dispatch('files_containing', '/ram/d', ['a'], {
          whole_word: false,
          ignore_case: false,
        })) as PathSpec[]
        expect(hits.map((hit) => hit.virtual)).toEqual(['/ram/d/a.txt'])
        for (const [scope, scopes] of [
          ['/ram/d', []],
          ['/ram/d/a.txt', []],
          ['/ram/d/a.txt', [PathSpec.fromStrPath('/ram/d')]],
        ] as const) {
          const records = await ws.dispatch('search', scope, [{ query: 'a', options: {} }], {
            scopes,
          })
          expect(records).toEqual([['/ram/d/a.txt', '/ram/d/a.txt\nabout /d/a.txt']])
        }
        expect(vfs.batches).toEqual([['/ram/d/a.txt', '/ram/d']])
      })
    } finally {
      await ws.close()
    }
  })

  // Twin of test_scopes_on_two_mounts_are_searched_one_by_one.
  it('searches scopes on two mounts one by one', async () => {
    const one = searched()
    const two = searched()
    const ws = new Workspace({ '/one': one, '/two': two })
    try {
      const records = (await ws.dispatch('search', '/one/d', [{ query: 'a', options: {} }], {
        scopes: [PathSpec.fromStrPath('/two/d')],
      })) as [string, string][]
      expect(records.map(([hit]) => hit)).toEqual([
        '/one/d/a.txt',
        '/one/d/secret/b.txt',
        '/two/d/a.txt',
        '/two/d/secret/b.txt',
      ])
      expect([one.batches, two.batches]).toEqual([[], []])
    } finally {
      await ws.close()
    }
    // A postVfs policy judges each scope's answer, so the scopes of one mount
    // are searched one by one too.
    const done: string[] = []
    const seen: Policy = {
      postVfs: (ctx: VfsResultContext) => {
        if (ctx.call.name === 'search') done.push(ctx.path.virtual)
        return null
      },
    }
    const vfs = searched()
    const judged = new Workspace({ '/ram': vfs }, { policies: [seen] })
    try {
      await judged.dispatch('search', '/ram/d/a.txt', [{ query: 'a', options: {} }], {
        scopes: [PathSpec.fromStrPath('/ram/d/secret')],
      })
      expect([vfs.batches, done]).toEqual([[], ['/ram/d/a.txt', '/ram/d/secret']])
    } finally {
      await judged.close()
    }
  })

  // Twin of test_a_read_ahead_keeps_what_one_batch_answers.
  it('keeps what one read-ahead batch answers', async () => {
    const vfs = new BatchedRAM()
    const ws = new Workspace({ '/r': vfs })
    const session = new SessionState({
      sessionId: 'agent',
      visibility: { paths: { paths: ['/r/secret'] } },
    })
    try {
      const data = await runWithSession(session, async () => {
        await ws.dispatch('read_many', '/r/a', [], {
          paths: [PathSpec.fromStrPath('/r/b'), PathSpec.fromStrPath('/r/secret/c')],
        })
        return ws.dispatch('read', '/r/b')
      })
      expect(vfs.batches).toEqual([['/r/a', '/r/b']])
      expect([DEC.decode(data as Uint8Array), vfs.reads]).toEqual(['b\n', []])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_read_ahead_reads_only_the_files_listed_small.
  it('reads ahead only the files listed small', async () => {
    const vfs = new BatchedRAM(false)
    vfs.store.files.set('/big', new Uint8Array(READ_AHEAD_BYTES + 1))
    const ws = new Workspace({ '/r': vfs })
    try {
      await ws.mount('/r').index.setDir(
        '/r',
        (
          [
            ['a', 2],
            ['big', READ_AHEAD_BYTES + 1],
          ] as const
        ).map(([name, size]) => [name, new FileStat({ name, type: FileType.FILE, size })]),
      )
      await ws.dispatch('read_many', '/r/a', [], {
        paths: [PathSpec.fromStrPath('/r/big'), PathSpec.fromStrPath('/r/b')],
      })
      expect(vfs.reads).toEqual(['/r/a'])
      await ws.dispatch('read', '/r/a')
      expect(vfs.reads).toEqual(['/r/a'])
    } finally {
      await ws.close()
    }
  })

  it('skips cache probes for index-known directories', async () => {
    const vfs = new BatchedRAM()
    vfs.store.dirs.add('/empty')
    const ws = new Workspace({ '/r': vfs })
    try {
      await ws.mount('/r').index.setDir('/r', [
        ['a', new FileStat({ name: 'a', type: FileType.FILE, size: 2 })],
        ['secret', new FileStat({ name: 'secret', type: FileType.DIRECTORY })],
        ['empty', new FileStat({ name: 'empty', type: FileType.DIRECTORY })],
      ])
      const exists = vi.spyOn(ws.cache, 'exists')
      await ws.dispatch('read_many', '/r/a', [], {
        paths: [PathSpec.fromStrPath('/r/secret'), PathSpec.fromStrPath('/r/empty')],
      })
      expect(exists.mock.calls.map(([path]) => path)).toEqual(['/r/a'])
      expect(vfs.batches).toEqual([['/r/a']])
    } finally {
      await ws.close()
    }
  })

  it('batches metadata lookups for warm read-ahead', async () => {
    const vfs = new BatchedRAM()
    const ws = new Workspace({ '/r': vfs })
    try {
      await ws.dispatch('read_many', '/r/a', [], { paths: [PathSpec.fromStrPath('/r/b')] })
      const lookup = vi.spyOn(ws.mount('/r').index, 'getMany')
      await ws.dispatch('read_many', '/r/a', [], { paths: [PathSpec.fromStrPath('/r/b')] })
      expect(lookup).toHaveBeenCalledExactlyOnceWith(['/r/a', '/r/b'])
      expect(vfs.batches).toEqual([['/r/a', '/r/b']])
      expect(await ws.dispatch('read', '/r/a')).toEqual(ENC.encode('a\n'))
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_read_ahead_fetches_nothing_a_policy_could_refuse.
  it('reads ahead nothing a policy could refuse', async () => {
    const vfs = new BatchedRAM()
    const locked: Policy = {
      preVfs: (ctx: VfsContext) =>
        ctx.path.virtual.startsWith('/data/locked/') ? { kind: 'deny', reason: 'locked\n' } : null,
    }
    const ws = new Workspace({ '/r': vfs }, { policies: [locked] })
    try {
      await ws.dispatch('read_many', '/r/a', [], { paths: [PathSpec.fromStrPath('/r/b')] })
      expect([vfs.batches, vfs.reads]).toEqual([[], []])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_hide_still_declines_a_tree_removal.
  it('still declines a tree removal', async () => {
    const ws = new Workspace({ '/ram': searched() }, { mode: MountMode.WRITE })
    try {
      await expect(
        runWithSession(secretHidden(), () => ws.dispatch('rm_r', '/ram/d')),
      ).rejects.toMatchObject({ declined: true })
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_scan_guard_counts_only_the_files_the_session_sees.
  it('hands a walk guard only the files the session sees', async () => {
    const vfs = searched()
    const ws = new Workspace({ '/ram': vfs })
    try {
      await runWithSession(secretHidden(), () => ws.dispatch('before_full_walk', '/ram/d'))
      expect(vfs.counted).toEqual([1])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_hide_drops_a_hit_whose_name_reads_like_a_score.
  it('drops a hit whose name reads like a score', async () => {
    const vfs = searched()
    vfs.store.files.set('/d/n:12', new TextEncoder().encode('n\n'))
    const ws = new Workspace({ '/ram': vfs })
    const session = new SessionState({
      sessionId: 'agent',
      visibility: { paths: { paths: ['/ram/d/n:12'] } },
    })
    try {
      const records = (await runWithSession(session, () =>
        ws.dispatch('search', '/ram/d', [{ query: 'n', options: {} }]),
      )) as [string, string][]
      expect(records.map(([hit]) => hit)).not.toContain('/ram/d/n:12')
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_mount_with_no_scan_guard_is_not_counted.
  it('counts nothing for a mount with no walk guard', async () => {
    const vfs = new TreeCountingRAM()
    vfs.store.dirs.add('/d')
    const ws = new Workspace({ '/ram': vfs })
    try {
      const answer = await ws.dispatch('before_full_walk', '/ram/d')
      expect([answer, vfs.trees]).toEqual([null, 0])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_search_past_the_walk_limit_stops_there.
  it.each([LimitedRAM, ListedRAM])('stops a search past the walk limit (%o)', async (cls) => {
    const ws = new Workspace({ '/ram': limited(cls, 3) })
    try {
      const out = await ws.shell('grep -r a /ram/d')
      expect([out.stdoutText, new TextDecoder().decode(out.stderr), out.exitCode]).toEqual([
        '/ram/d/a0.txt:a\n/ram/d/a1.txt:a\n',
        'grep: /ram/d: stopped after 2 files (walk_limit); narrow the path\n',
        2,
      ])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_listing_past_the_walk_limit_stops_there.
  it.each(
    [LimitedRAM, ListedRAM].flatMap((cls) =>
      (
        [
          ['find /ram/d', '/ram/d\n/ram/d/a0.txt\n/ram/d/a1.txt\n', 1],
          ['ls -R /ram/d', '/ram/d:\na0.txt\na1.txt\n', 1],
          ['tree /ram/d', '/ram/d\n|-- a0.txt\n`-- a1.txt\n\n1 directory, 2 files\n', 2],
          ['du -a /ram/d', '2\t/ram/d/a0.txt\n2\t/ram/d/a1.txt\n4\t/ram/d\n', 1],
        ] as const
      ).map(([line, out, code]) => [cls, line, out, code] as const),
    ),
  )('stops a listing past the walk limit (%o, %s)', async (cls, line, out, code) => {
    const ws = new Workspace({ '/ram': limited(cls, 3) })
    try {
      const result = await ws.shell(line)
      const name = line.split(' ')[0] ?? ''
      expect([result.stdoutText, new TextDecoder().decode(result.stderr), result.exitCode]).toEqual(
        [out, `${name}: /ram/d: stopped after 2 files (walk_limit); narrow the path\n`, code],
      )
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_listing_across_mounts_stops_at_each_mounts_limit.
  it('stops a listing across mounts at each mount limit', async () => {
    const ws = new Workspace({ '/a': limited(LimitedRAM, 3), '/b': limited(LimitedRAM, 3) })
    try {
      const result = await ws.shell('ls -R /a/d /b/d')
      expect([result.stdoutText, new TextDecoder().decode(result.stderr), result.exitCode]).toEqual(
        [
          '/a/d:\na0.txt\na1.txt\n\n/b/d:\na0.txt\na1.txt\n',
          'ls: /a/d: stopped after 2 files (walk_limit); narrow the path\n' +
            'ls: /b/d: stopped after 2 files (walk_limit); narrow the path\n',
          1,
        ],
      )
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_glob_past_the_walk_limit_is_refused.
  const refused = '/ram/d/*: matches more than 2 files (walk_limit); narrow the path'
  it.each([
    ['cat /ram/d/*; echo $?', '126\n', `cat: Argument list too long\ncat: ${refused}\n`],
    ['echo /ram/d/*; echo $?', '126\n', `echo: Argument list too long\necho: ${refused}\n`],
    ['for f in /ram/d/*; do echo $f; done; echo after', '', `bash: ${refused}\n`],
    ['cat /ram/d/a*', 'a\na\n', ''],
    ['echo /ram/d/*/b.txt', '/ram/d/secret/b.txt\n', ''],
  ])('refuses a glob past the walk limit: %s', async (line, out, err) => {
    const ws = new Workspace({ '/ram': limited(LimitedRAM, 3) })
    try {
      const result = await ws.shell(line)
      expect([result.stdoutText, new TextDecoder().decode(result.stderr)]).toEqual([out, err])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_glob_counts_against_the_profiles_walk_limit.
  it("counts a glob against the profile's walk limit", async () => {
    const ws = new Workspace({ '/ram': limited(RAMVFS, 3) })
    try {
      ws.createSession('capped', {
        profile: { commandLimits: { [ALL_COMMANDS]: new Limit({ walkLimit: 2 }) } },
      })
      const result = await ws.shell('echo /ram/d/*; echo $?', { sessionId: 'capped' })
      expect([result.stdoutText, new TextDecoder().decode(result.stderr)]).toEqual([
        '126\n',
        `echo: Argument list too long\necho: ${refused}\n`,
      ])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_named_file_counts_nothing_against_a_walk.
  it('counts a named file nothing against a walk', async () => {
    const vfs = new LimitedRAM()
    vfs.store.dirs.add('/d')
    for (let i = 0; i < 2; i++) {
      vfs.store.files.set(`/d/a${String(i)}.txt`, new TextEncoder().encode('a\n'))
    }
    const ws = new Workspace({ '/ram': vfs })
    try {
      const out = await ws.shell('grep -r a /ram/d /ram/d/a0.txt')
      expect([out.stdoutText, new TextDecoder().decode(out.stderr), out.exitCode]).toEqual([
        '/ram/d/a0.txt:a\n/ram/d/a1.txt:a\n/ram/d/a0.txt:a\n',
        '',
        0,
      ])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_lines_a_search_hands_over_count_against_the_limit.
  it('counts the lines a search hands over against the limit', async () => {
    const vfs = new LinedRAM()
    vfs.store.dirs.add('/d')
    for (let i = 0; i < 4; i++) {
      vfs.store.files.set(`/d/f${String(i)}.txt`, new TextEncoder().encode('hello\nother\n'))
    }
    const ws = new Workspace({ '/ram': vfs })
    try {
      const out = await ws.shell('grep -r hello /ram/d')
      expect([out.stdoutText, new TextDecoder().decode(out.stderr), out.exitCode]).toEqual([
        '/ram/d/f0.txt:hello\n/ram/d/f1.txt:hello\n',
        'grep: /ram/d: stopped after 2 files (walk_limit); narrow the path\n',
        2,
      ])
    } finally {
      await ws.close()
    }
    expect(vfs.asked).toEqual(['/ram/d/f0.txt', '/ram/d/f1.txt'])
  })

  // Twin of test_a_planned_rg_counts_each_file_against_its_own_mount.
  it.each(['path', 'modified'])(
    'counts each file of a planned rg against its own mount (--sort %s)',
    async (sort) => {
      const top = new RAMVFS()
      top.store.files.set('/t.txt', new TextEncoder().encode('hello\n'))
      const remote = new RAMVFS()
      for (let i = 0; i < 4; i++) {
        remote.store.files.set(`/r${String(i)}.txt`, new TextEncoder().encode('hello\n'))
      }
      const ws = new Workspace(
        {
          '/a': [top, MountMode.READ, { [ALL_COMMANDS]: new Limit({ walkLimit: -1 }) }],
          '/a/remote': [remote, MountMode.READ, { [ALL_COMMANDS]: new Limit({ walkLimit: 2 }) }],
        },
        {},
      )
      try {
        const out = await ws.shell(`rg --sort ${sort} -l hello /a`)
        expect([
          out.stdoutText.split('\n').filter(Boolean).sort(),
          new TextDecoder().decode(out.stderr),
          out.exitCode,
        ]).toEqual([
          ['/a/remote/r0.txt', '/a/remote/r1.txt', '/a/t.txt'],
          'rg: /a/remote: stopped after 2 files (walk_limit); narrow the path\n',
          2,
        ])
      } finally {
        await ws.close()
      }
    },
  )

  // Twin of test_a_glob_counts_each_match_against_its_own_mount.
  it.each(['cat', 'echo'])('counts each glob match against its own mount (%s)', async (command) => {
    const top = new RAMVFS()
    top.store.dirs.add('/b')
    top.store.files.set('/b/t.txt', new TextEncoder().encode('t\n'))
    const remote = new RAMVFS()
    for (let i = 0; i < 3; i++) {
      remote.store.files.set(`/r${String(i)}.txt`, new TextEncoder().encode('r\n'))
    }
    const ws = new Workspace(
      {
        '/a': [top, MountMode.READ, { [ALL_COMMANDS]: new Limit({ walkLimit: -1 }) }],
        '/a/remote': [remote, MountMode.READ, { [ALL_COMMANDS]: new Limit({ walkLimit: 2 }) }],
      },
      {},
    )
    const refused = '/a/*/*.txt: matches more than 2 files (walk_limit); narrow the path'
    try {
      const out = await ws.shell(`${command} /a/*/*.txt; echo $?`)
      expect([out.stdoutText, new TextDecoder().decode(out.stderr)]).toEqual([
        '126\n',
        `${command}: Argument list too long\n${command}: ${refused}\n`,
      ])
    } finally {
      await ws.close()
    }
  })

  it('counts a glob through a link against the target mount', async () => {
    const top = new RAMVFS()
    top.store.dirs.add('/data')
    for (let i = 0; i < 3; i++) {
      top.store.files.set(`/data/t${String(i)}.txt`, new TextEncoder().encode('t\n'))
    }
    const ws = new Workspace(
      {
        '/a': [top, MountMode.WRITE, { [ALL_COMMANDS]: new Limit({ walkLimit: -1 }) }],
        '/a/remote': [
          new RAMVFS(),
          MountMode.WRITE,
          { [ALL_COMMANDS]: new Limit({ walkLimit: 2 }) },
        ],
      },
      { mode: MountMode.WRITE },
    )
    try {
      await ws.shell('ln -s /a/data /a/remote/link')
      const out = await ws.shell('echo /a/*/*/*.txt; echo $?')
      expect([out.stdoutText, new TextDecoder().decode(out.stderr)]).toEqual([
        '/a/remote/link/t0.txt /a/remote/link/t1.txt /a/remote/link/t2.txt\n0\n',
        '',
      ])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_rm_r_leaves_the_files_a_nested_mount_covers.
  it.each([LimitedRAM, ListedRAM])(
    'rm -r leaves the files a nested mount covers (%o)',
    async (cls) => {
      const vfs = new cls()
      vfs.store.dirs.add('/d')
      vfs.store.dirs.add('/d/sub')
      vfs.store.files.set('/d/x.txt', new TextEncoder().encode('x\n'))
      for (let i = 0; i < 3; i++) {
        vfs.store.files.set(`/d/sub/c${String(i)}.txt`, new TextEncoder().encode('c\n'))
      }
      const ws = new Workspace(
        { '/ram': vfs, '/ram/d/sub': new RAMVFS() },
        { mode: MountMode.WRITE },
      )
      try {
        const out = await ws.shell('rm -r /ram/d; echo $?')
        expect([out.stdoutText, new TextDecoder().decode(out.stderr)]).toEqual([
          '1\n',
          "rm: skipping '/ram/d/sub', since it's on a different device\n",
        ])
      } finally {
        await ws.close()
      }
      expect([...vfs.store.files.keys()].sort()).toEqual([
        '/d/sub/c0.txt',
        '/d/sub/c1.txt',
        '/d/sub/c2.txt',
      ])
    },
  )

  // Twin of test_a_copy_past_the_walk_limit_is_refused.
  it.each([LimitedRAM, ListedRAM])('refuses a copy past the walk limit (%o)', async (cls) => {
    const ws = new Workspace({ '/ram': limited(cls, 3) }, { mode: MountMode.WRITE })
    try {
      const out = await ws.shell('tar -cf /ram/d.tar /ram/d')
      expect([out.stdoutText, new TextDecoder().decode(out.stderr), out.exitCode]).toEqual([
        '',
        'tar: more than 2 files in scope (walk_limit); narrow the path\n',
        1,
      ])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_full_walk_follows_the_commands_walk_limit.
  it("follows the command's walk limit on a full walk", async () => {
    const vfs = limited(RAMVFS, 3)
    const ws = new Workspace(
      { '/ram': [vfs, MountMode.WRITE, { rm: new Limit({ walkLimit: 2 }) }] },
      { mode: MountMode.WRITE },
    )
    try {
      const out = await ws.shell('rm -r /ram/d')
      expect([new TextDecoder().decode(out.stderr), out.exitCode]).toEqual([
        'rm: more than 2 files in scope (walk_limit); narrow the path\n',
        1,
      ])
    } finally {
      await ws.close()
    }
    expect(vfs.store.files.size).toBe(3)
  })

  // Twin of test_a_null_walk_limit_lifts_the_mounts.
  it.each([
    ['tar', 'cd /ram && tar -cf d.tar d; echo $?', '0\n'],
    ['find', 'find /ram/d -type f | wc -l', '3\n'],
  ])("lifts the mount's walk limit with a null one: %s", async (name, line, out) => {
    const ws = new Workspace(
      {
        '/ram': [
          limited(LimitedRAM, 3),
          MountMode.WRITE,
          { [name]: new Limit({ walkLimit: null }) },
        ],
      },
      { mode: MountMode.WRITE },
    )
    try {
      const result = await ws.shell(line)
      expect([result.stdoutText, new TextDecoder().decode(result.stderr)]).toEqual([out, ''])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_registered_command_walks_under_its_declared_limit.
  it('walks a registered command under its declared limit', async () => {
    const ws = new Workspace({ '/ram': limited(RAMVFS, 3) })
    try {
      const mount = ws.mount('/ram')
      const find = mount.resolveCommand('find')
      if (find === null) throw new Error('no find')
      mount.registerCommands([
        new Command({
          name: find.name,
          spec: find.spec,
          vfs: find.vfs,
          filetype: find.filetype,
          fn: find.fn,
          aggregate: find.aggregate,
          write: find.write,
          limit: new Limit({ walkLimit: 2 }),
        }),
      ])
      const result = await ws.shell('find /ram/d')
      expect([result.stdoutText, new TextDecoder().decode(result.stderr), result.exitCode]).toEqual(
        [
          '/ram/d\n/ram/d/a0.txt\n/ram/d/a1.txt\n',
          'find: /ram/d: stopped after 2 files (walk_limit); narrow the path\n',
          1,
        ],
      )
    } finally {
      await ws.close()
    }
  })

  // Twin of test_two_mounts_of_one_vfs_settle_on_one_walk_limit.
  it('settles two mounts of one VFS on one walk limit', async () => {
    const capped = { [ALL_COMMANDS]: new Limit({ walkLimit: 2 }) }
    const lone = limited(RAMVFS, 3)
    expect(() => new Workspace({ '/a': [lone, MountMode.READ, capped], '/b': lone })).toThrow(
      "mount /a/: walk_limit 2 differs from /b/'s 10000 on the same VFS",
    )
    const vfs = limited(RAMVFS, 3)
    const ws = new Workspace({
      '/a': [vfs, MountMode.READ, capped],
      '/b': [vfs, MountMode.READ, capped],
    })
    try {
      const result = await ws.shell('ls -R /b/d')
      expect(new TextDecoder().decode(result.stderr)).toBe(
        'ls: /b/d: stopped after 2 files (walk_limit); narrow the path\n',
      )
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_copy_counts_no_file_a_nested_mount_covers.
  it.each([LimitedRAM, ListedRAM])('counts no file a nested mount covers (%o)', async (cls) => {
    const vfs = new cls()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/x.txt', new TextEncoder().encode('x\n'))
    for (let i = 0; i < 3; i++) {
      vfs.store.files.set(`/d/sub/c${String(i)}.txt`, new TextEncoder().encode('c\n'))
    }
    const ws = new Workspace({ '/ram': vfs, '/ram/d/sub': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const out = await ws.shell('tar -cf /ram/d.tar /ram/d; tar -tf /ram/d.tar')
      expect([out.stdoutText, out.exitCode]).toEqual(['ram/d/\nram/d/sub/\nram/d/x.txt\n', 0])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_walk_within_the_walk_limit_runs.
  it.each([LimitedRAM, ListedRAM])('runs a walk within the walk limit (%o)', async (cls) => {
    const ws = new Workspace({ '/ram': limited(cls, 2) })
    try {
      const out = await ws.shell('grep -rl a /ram/d')
      expect([out.stdoutText, out.exitCode]).toEqual(['/ram/d/a0.txt\n', 0])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_hidden_file_does_not_count_to_the_walk_limit.
  it.each([LimitedRAM, ListedRAM])(
    'does not count a hidden file toward the walk limit (%o)',
    async (cls) => {
      const ws = new Workspace({ '/ram': limited(cls, 3) })
      try {
        const answer = await runWithSession(secretHidden(), () =>
          ws.dispatch('before_full_walk', '/ram/d'),
        )
        expect(answer).toBeNull()
      } finally {
        await ws.close()
      }
    },
  )

  // Twin of test_a_listed_count_stops_one_file_past_the_limit.
  it('stops a listed count one file past the limit', async () => {
    const vfs = new ListedRAM()
    vfs.store.dirs.add('/d')
    for (let i = 0; i < 6; i++) {
      vfs.store.dirs.add(`/d/s${String(i)}`)
      vfs.store.files.set(`/d/s${String(i)}/f.txt`, new TextEncoder().encode('f\n'))
    }
    const ws = new Workspace({ '/ram': vfs })
    try {
      await expect(ws.dispatch('before_full_walk', '/ram/d')).rejects.toThrow('more than 2 files')
      expect(vfs.listed).toHaveLength(4)
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_cut_listing_is_not_kept_as_the_whole_directory.
  it('does not keep a cut listing as the whole directory', async () => {
    const vfs = new CutRAM()
    const ws = new Workspace({ '/ram': vfs })
    try {
      const cut = (await ws.dispatch('readdir', '/ram/d', [], { limit: 2 })) as string[]
      const whole = (await ws.dispatch('readdir', '/ram/d')) as string[]
      expect(vfs.asked).toEqual([2, undefined])
      expect([cut.length, whole.length]).toEqual([2, 3])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_hide_below_a_listing_drops_the_walks_limit.
  it('drops the walk limit from a listing a hide filters', async () => {
    const vfs = new CutRAM()
    const ws = new Workspace({ '/ram': vfs })
    try {
      const sess = ws.createSession('veiled', { profile: { paths: { hide: ['/ram/d/sec'] } } })
      const listed = await runWithSession(sess, () =>
        ws.dispatch('readdir', '/ram/d', [], { limit: 2 }),
      )
      expect(vfs.asked).toEqual([undefined])
      expect(listed).toEqual(['/ram/d/a', '/ram/d/b'])
    } finally {
      await ws.close()
    }
  })
})

it('path admission checks aliases without backend I/O', async () => {
  const ram = new RAMVFS()
  const ws = new Workspace({ '/data': ram }, { mode: MountMode.WRITE })
  try {
    await ws.shell('mkdir /data/real; ln -s /data/real /data/alias')
    const call = vi
      .spyOn(MountEntry.prototype, 'callKeyed')
      .mockRejectedValue(new Error('unexpected backend call'))
    const probe = { admit_only: true }
    await expect(
      byCommand(ws, refusing('/data/alias/new').gate, 'stat', '/data/alias/new', [], probe),
    ).rejects.toThrow('sealed')
    const { gate, asked } = refusing('/unrelated')
    const [result] = await byCommand(ws, gate, 'stat', '/data/alias/new', [], probe)
    expect(result).toBeNull()
    expect(asked).toEqual(['/data/alias/new', '/data/real/new'])
    expect(call).not.toHaveBeenCalled()
    call.mockRestore()
  } finally {
    await ws.close()
  }
})

describe('hides answer before any policy', () => {
  it('a hide answers before any policy and leaves no record', async () => {
    const sealedReads: Policy = {
      preVfs: (c: VfsContext): Action | null =>
        !c.write && c.path.virtual === '/data/secret' ? { kind: 'deny', reason: 'sealed' } : null,
    }
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, policies: [sealedReads] },
    )
    try {
      await ws.shell('echo s > /data/secret')
      ws.createSession('veiled', { profile: { paths: { hide: ['/data/secret'] } } })
      const hidden: unknown = await ws.vfs
        .read('/data/secret', {}, 'veiled')
        .catch((e: unknown) => e)
      expect((hidden as { code?: string }).code).toBe('ENOENT')
      expect((hidden as { refusal?: unknown }).refusal ?? null).toBeNull()
      const denied: unknown = await ws.vfs.read('/data/secret').catch((e: unknown) => e)
      expect((denied as { refusal?: { reason: string } }).refusal?.reason).toBe('sealed')
    } finally {
      await ws.close()
    }
  })

  // A probe reads on the caller's behalf: a path the caller cannot see is
  // absent to it, as the walk answers, and neither a policy nor the backend
  // hears of it.
  it('a probe of a hidden path answers as absent before any policy', async () => {
    const asked: string[] = []
    const listening: Policy = {
      preVfs: (c: VfsContext): Action | null => {
        asked.push(c.path.virtual)
        return null
      },
    }
    const ram = new RAMVFS()
    const ws = new Workspace({ '/data': ram }, { mode: MountMode.WRITE, policies: [listening] })
    try {
      await ws.shell('mkdir /data/hid && echo k > /data/hid/x')
      const internals = ws as unknown as {
        dispatcher: {
          probeRead(name: string, resolved: [BaseVFS, PathSpec, MountMode]): Promise<unknown>
        }
      }
      const sess = new SessionState({
        sessionId: 'agent',
        visibility: { paths: { paths: ['/data/hid'] } },
      })
      const stat = vi.spyOn(ram, 'stat')
      asked.length = 0
      const probe = runWithSession(sess, () =>
        internals.dispatcher.probeRead('stat', [
          ram,
          PathSpec.fromStrPath('/data/hid/x'),
          MountMode.WRITE,
        ]),
      )
      await expect(probe).rejects.toMatchObject({ code: 'ENOENT' })
      expect(asked).toEqual([])
      expect(stat).not.toHaveBeenCalled()
    } finally {
      await ws.close()
    }
  })
})

describe('retained reads use the shared policy boundary', () => {
  it.each(['/data/file', '/unmounted'])(
    'checks pre and post policy at %s without fetching',
    async (path) => {
      let stage = ''
      const seen: [string, string | null][] = []
      const policy: Policy = {
        preVfs(ctx) {
          if (ctx.call.name !== 'read') return null
          seen.push(['pre', null])
          return stage === 'pre' ? { kind: 'deny', reason: 'pre sealed' } : null
        },
        postVfs(ctx) {
          if (ctx.call.name !== 'read') return null
          expect(ctx.result).toBeInstanceOf(Uint8Array)
          seen.push(['post', DEC.decode(ctx.result as Uint8Array)])
          return stage === 'post' ? { kind: 'deny', reason: 'post sealed' } : null
        },
      }
      const ws = new Workspace({ '/data': new RAMVFS() }, { policies: [policy] })
      const call = vi
        .spyOn(MountEntry.prototype, 'callKeyed')
        .mockRejectedValue(new Error('unexpected backend call'))
      try {
        for (stage of ['pre', 'post', '']) {
          seen.length = 0
          const read = ws.vfs.dispatch('read', path, [], { retained: ENC.encode('secret') })
          if (stage) await expect(read).rejects.toMatchObject({ code: 'EACCES' })
          else expect((await read)[0]).toEqual(ENC.encode('secret'))
          expect(seen).toEqual(
            stage === 'pre'
              ? [['pre', null]]
              : [
                  ['pre', null],
                  ['post', 'secret'],
                ],
          )
        }
        expect(call).not.toHaveBeenCalled()
      } finally {
        call.mockRestore()
        await ws.close()
      }
    },
  )

  it('refuses a hidden retained read before policy and restores it', async () => {
    const seen: string[] = []
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        policies: [
          {
            preVfs(ctx) {
              seen.push(ctx.call.name)
              return null
            },
          },
        ],
      },
    )
    const session = ws.createSession('reader', { profile: { paths: { hide: ['/data/f'] } } })
    const call = vi
      .spyOn(MountEntry.prototype, 'callKeyed')
      .mockRejectedValue(new Error('unexpected backend call'))
    try {
      await runWithSession(session, async () => {
        await expect(
          ws.vfs.dispatch('read', '/data/f', [], { retained: ENC.encode('secret') }),
        ).rejects.toMatchObject({ code: 'ENOENT' })
        expect(seen).toEqual([])
        await ws.setSessionProfile('reader', {})
        expect(
          (await ws.vfs.dispatch('read', '/data/f', [], { retained: ENC.encode('secret') }))[0],
        ).toEqual(ENC.encode('secret'))
        expect(ws.vfs.records).toEqual([])
      })
      expect(call).not.toHaveBeenCalled()
    } finally {
      call.mockRestore()
      await ws.close()
    }
  })

  it.each([
    ['read', null],
    ['read', 'secret'],
    ['write', ENC.encode('secret')],
  ])('rejects invalid retained arguments for %s', async (op, retained) => {
    const ws = new Workspace({ '/': new RAMVFS() })
    try {
      await expect(ws.vfs.dispatch(op, '/file', [], { retained })).rejects.toThrow(
        'retained is only valid',
      )
    } finally {
      await ws.close()
    }
  })
})

class NativeCopyRAM extends RAMVFS {
  nativeCopies = 0

  override async copy(src: PathSpec, dst: PathSpec): Promise<void> {
    this.nativeCopies += 1
    await super.copy(src, dst)
  }

  override copyFrom(_source: BaseVFS, _src: PathSpec, dst: PathSpec): Promise<void> {
    this.nativeCopies += 1
    return Promise.reject(exdev(dst))
  }
}

it.each([false, true])(
  'checks source post-read policy before native copy (cross-mount: %s)',
  async (crossMount) => {
    let sealed = true
    const policy: Policy = {
      postVfs(ctx) {
        return sealed && ctx.call.name === 'read' && ctx.path.virtual === '/data/secret'
          ? { kind: 'deny', reason: 'sensitive source' }
          : null
      },
    }
    const source = new NativeCopyRAM()
    const other = new NativeCopyRAM()
    const ws = new Workspace(
      { '/data/': source, '/other/': other },
      {
        mode: MountMode.WRITE,
        policies: [policy],
      },
    )
    const destination = crossMount ? '/other/copied' : '/data/copied'
    try {
      await ws.vfs.write('/data/secret', ENC.encode('secret'))
      const refused = await ws.shell(`cp /data/secret ${destination}`)
      expect(refused.exitCode).toBe(1)
      expect(DEC.decode(refused.stderr)).toContain('Permission denied')
      await expect(ws.vfs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(source.nativeCopies + other.nativeCopies).toBe(0)
      sealed = false
      const restored = await ws.shell(`cp /data/secret ${destination}`)
      expect(restored.exitCode).toBe(0)
      expect(await ws.vfs.read(destination)).toEqual(ENC.encode('secret'))
      // A postVfs hook judges the bytes, so they move through a read and a
      // write: the bytes it judged are the bytes that landed.
      expect(source.nativeCopies + other.nativeCopies).toBe(0)
    } finally {
      await ws.close()
    }
  },
)

it.each(['/data/file', '/unmounted'])(
  'checks retained stat policy at %s without backend calls',
  async (path) => {
    let stage = ''
    const seen: string[] = []
    const row = new FileStat({ name: 'file', type: FileType.FILE, extra: { tag: 'kept' } })
    const policy: Policy = {
      preVfs(ctx) {
        if (ctx.call.name !== 'stat') return null
        seen.push('pre')
        return stage === 'pre' ? { kind: 'deny', reason: 'stat sealed' } : null
      },
      postVfs(ctx) {
        if (ctx.call.name !== 'stat') return null
        seen.push('post')
        expect(ctx.result).toEqual(row)
        return stage === 'post' ? { kind: 'deny', reason: 'stat result sealed' } : null
      },
    }
    const ws = new Workspace({ '/data': new RAMVFS() }, { policies: [policy] })
    const session = ws.createSession('reader')
    const call = vi
      .spyOn(MountEntry.prototype, 'callKeyed')
      .mockRejectedValue(new Error('retained stat reached backend'))
    try {
      await runWithSession(session, async () => {
        for (stage of ['pre', 'post', '']) {
          seen.length = 0
          const result = ws.vfs.dispatch('stat', path, [], { retained: row })
          if (stage) await expect(result).rejects.toMatchObject({ code: 'EACCES' })
          else expect((await result)[0]).toEqual(row)
          expect(seen).toEqual(stage === 'pre' ? ['pre'] : ['pre', 'post'])
        }
        await ws.setSessionProfile('reader', { paths: { hide: [path] } })
        seen.length = 0
        await expect(ws.vfs.dispatch('stat', path, [], { retained: row })).rejects.toMatchObject({
          code: 'ENOENT',
        })
        expect(seen).toEqual([])
        await ws.setSessionProfile('reader', {})
        expect((await ws.vfs.dispatch('stat', path, [], { retained: row }))[0]).toEqual(row)
      })
      expect(call).not.toHaveBeenCalled()
    } finally {
      call.mockRestore()
      await ws.close()
    }
  },
)

class CountedRemoval extends RAMVFS {
  removals = 0

  override rmR(path: PathSpec): Promise<void> {
    this.removals += 1
    return super.rmR(path)
  }
}

it.each([
  ['/other/sealed', 1],
  ['/d/t/a/f', 0],
])("declines a line's tree removal only for a rule below it (%s)", async (sealed, removals) => {
  // The line's gate answers for the profile's rules, scoped to the paths a
  // walk reaches: a rule over another mount declines nothing.
  const vfs = new CountedRemoval()
  const ws = new Workspace({ '/d': vfs, '/other': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    ws.createSession('agent', {
      profile: { commands: { deny: [{ paths: [sealed], reason: 'sealed' }] } },
    })
    await ws.shell('mkdir -p /d/t/a && echo hi > /d/t/a/f')
    await ws.shell('rm -r /d/t', { sessionId: 'agent' })
    expect(vfs.removals).toBe(removals)
  } finally {
    await ws.close()
  }
})

it('has a preVfs policy judge a shortcut without a whole read', async () => {
  // preVfs judges the shortcut as the read it stands in for; only a postVfs
  // policy, which judges bytes a count or a checksum does not carry, sends it
  // to a whole read.
  const vfs = new StandInRAM()
  vfs.store.dirs.add('/')
  vfs.store.files.set('/cold', ENC.encode('a\n'))
  const seen: string[] = []
  const policy: Policy = {
    preVfs(ctx) {
      seen.push(ctx.call.name)
      return null
    },
  }
  const ws = new Workspace({ '/m': vfs }, { policies: [policy] })
  try {
    const [answer] = await ws.vfs.dispatch('first_lines', '/m/cold', [1])
    expect(answer).toEqual(ENC.encode('stand-in\n'))
    expect(vfs.asked).toEqual(['first_lines'])
    expect(seen).toContain('read')
    expect(seen).not.toContain('first_lines')
  } finally {
    await ws.close()
  }
})

it('leaves the rest of a live pipe to the next reader under a postVfs policy', async () => {
  // A pipe's bytes come from the line's own writer; collecting them for a
  // postVfs policy would take what the next reader is owed.
  const ws = new Workspace({ '/ram': new RAMVFS() }, { policies: [{ postVfs: () => null }] })
  try {
    const result = await ws.shell(
      'f() { head -c 1 "$1"; echo; cat "$1"; }; f <(printf a; sleep 1; printf rest)',
    )
    expect(DEC.decode(result.stdout)).toBe('a\nrest')
  } finally {
    await ws.close()
  }
})

it('has a policy refusing reads refuse their shortcuts', async () => {
  const vfs = new StandInRAM()
  vfs.store.dirs.add('/')
  vfs.store.files.set('/cold', ENC.encode('a\n'))
  const policy: Policy = {
    preVfs: (ctx) => (ctx.call.name === 'read' ? { kind: 'deny', reason: 'no reads' } : null),
  }
  const ws = new Workspace({ '/m': vfs }, { policies: [policy] })
  try {
    for (const [name, args] of [
      ['first_lines', [1]],
      ['line_count', []],
    ] as [string, unknown[]][]) {
      await expect(ws.vfs.dispatch(name, '/m/cold', args)).rejects.toMatchObject({ code: 'EACCES' })
    }
    expect(vfs.asked).toEqual([])
  } finally {
    await ws.close()
  }
})

it.each([false, true])('admits a copy as a read of its source (refused: %s)', async (refused) => {
  // A preVfs hook needs no bytes: the source is judged as a read and the
  // backend's own copy runs, so a document stays a document.
  const vfs = new NativeCopyRAM()
  const policy: Policy = {
    preVfs: (ctx) =>
      refused && ctx.call.name === 'read' ? { kind: 'deny', reason: 'no reads' } : null,
  }
  const ws = new Workspace(
    { '/data/': vfs },
    {
      mode: MountMode.WRITE,
      policies: [policy],
    },
  )
  try {
    await ws.vfs.write('/data/a', ENC.encode('a'))
    const ran = await ws.shell('cp /data/a /data/b')
    expect(ran.exitCode).toBe(refused ? 1 : 0)
    expect(vfs.nativeCopies).toBe(refused ? 0 : 1)
  } finally {
    await ws.close()
  }
})

it('keeps the bytes of a copy from a pipe under file hooks', async () => {
  const ws = new Workspace(
    { '/ram': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      policies: [{ preVfs: () => null, postVfs: () => null }],
    },
  )
  try {
    const ran = await ws.shell('cp <(printf x) /ram/out')
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(await ws.vfs.read('/ram/out'))).toBe('x')
  } finally {
    await ws.close()
  }
})

class StalledWriteRAM extends RAMVFS {
  armed = false
  calls = 0
  release = (): void => undefined

  override async write(path: PathSpec, data: ByteSource): Promise<void> {
    if (this.armed) {
      this.calls += 1
      await new Promise<void>((resolve) => {
        this.release = resolve
      })
    }
    return super.write(path, data)
  }
}

it('a write queued behind a stalled one never runs once its line is aborted', async () => {
  // rm waits for the path's writer hold; its line's abort releases it from
  // the queue, so the unlink never lands once the stalled write lets go.
  const store = new StalledWriteRAM()
  const ws = new Workspace({ '/data': [store, MountMode.WRITE] }, { mode: MountMode.WRITE })
  ws.createSession('other')
  try {
    await ws.shell('echo keep > /data/f')
    store.armed = true
    const stalled = ws.shell('echo new > /data/f')
    await vi.waitFor(() => {
      expect(store.calls).toBe(1)
    })
    const controller = new AbortController()
    const removing = ws.shell('rm /data/f', { sessionId: 'other', signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await expect(removing).rejects.toMatchObject({ name: 'AbortError' })
    store.armed = false
    store.release()
    await stalled
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(DEC.decode((await ws.shell('cat /data/f')).stdout)).toBe('new\n')
  } finally {
    store.release()
    await ws.close()
  }
})
