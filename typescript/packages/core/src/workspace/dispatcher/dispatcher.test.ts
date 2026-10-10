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
import { materialize, OpReport } from '../../io/types.ts'
import { runWithSession } from '../../context/session_context.ts'
import { revisionFor } from '../../observe/context.ts'
import { MountEntry } from '../mount/mount.ts'
import { render } from '../../test-utils.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { POLICY_WRITE_OPS } from './constants.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { enoent, erofs } from '../../errors/fs.ts'
import { CommandTimeoutError } from '../../errors/types.ts'
import { LimitExceededError } from '../../commands/errors.ts'
import type { Policy } from '../../policy/base.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { Action, VfsContext, VfsResultContext } from '../../policy/types.ts'
import { sliceWindow, spliceWindow } from '../../utils/ranges.ts'
import { FileStat, FileType, Limit, MountMode, OnExceed, PathSpec } from '../../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { SessionState } from '../session/session.ts'
import { Workspace } from '../workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe('dispatch applies limits on the executing mount', () => {
  it('a symlink into a limited mount gets the target mount limit', async () => {
    const parser = await getTestParser()
    const data = new RAMVFS()
    const plain = new RAMVFS()
    const ws = new Workspace(
      {
        '/data': [data, MountMode.EXEC, { read: new Limit({ maxBytes: 8 }) }],
        '/r': plain,
      },
      { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.shell('echo 0123456789abcdef > /data/big.txt')
      await ws.shell('ln -s /data/big.txt /r/link')
      const direct = (await ws.dispatch('read', '/data/big.txt')) as Uint8Array
      const viaLink = (await ws.dispatch('read', '/r/link')) as Uint8Array
      // The link lives on the unlimited mount, but the read executes
      // on /data: its maxBytes cap must apply either way.
      expect(DEC.decode(viaLink)).toBe(DEC.decode(direct))
      expect(direct.byteLength).toBeLessThan(ENC.encode('0123456789abcdef\n').byteLength)
    } finally {
      await ws.close()
    }
  }, 30_000)
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
      const parser = await getTestParser()
      const ws = new Workspace(
        { '/a': new RAMVFS(), '/b': new RAMVFS(), '/x/m': new RAMVFS() },
        { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
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
      const parser = await getTestParser()
      const ws = new Workspace(
        { '/a': new RAMVFS(), '/b': new RAMVFS() },
        { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
      )
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
    const parser = await getTestParser()
    class DocRAM extends RAMVFS {
      override readonly renderers: Readonly<Record<string, string>> = {
        '.gdoc.json': 'readDoc',
      }

      readDoc(): Promise<Uint8Array> {
        return Promise.resolve(ENC.encode('rendered'))
      }
    }
    const ram = new DocRAM()
    const ws = new Workspace(
      { '/m': ram },
      { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
    )
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
  const parser = await getTestParser()
  const ws = new Workspace(
    { '/ram': new RAMVFS() },
    { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
  )
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

describe('unlink of a namespace link', () => {
  it('removes the link, which no backend can see', async () => {
    // The dispatcher creates links (`symlink`), so it has to remove them too: a
    // link has no backend entry, so forwarding the unlink reaches a backend
    // that has never heard of the name and answers ENOENT, leaving the link
    // in place. That is what left `git checkout` unable to drop a link the
    // other branch does not have.
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const ws = new Workspace(
      { '/ram': ram },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
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
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const ws = new Workspace(
      { '/ram': ram },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
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
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const ws = new Workspace(
      { '/ram': ram },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
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
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/ram': new RAMVFS(), '/scratch': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
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
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const ws = new Workspace(
      { '/ram': ram },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.shell('mkdir /ram/d && echo x > /ram/d/h.txt')
      const original = ram.readdir.bind(ram)
      let seen: string | null | undefined
      ram.readdir = (path, index) => {
        seen = revisionFor('/ram/d/h.txt')
        return original(path, index)
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
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/extra': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
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
        ctx.op === 'mkdir'
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
        if (ctx.op === 'mkdir') done.push(ctx.path.virtual)
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

  it('a rename destination is judged on its own turf', async () => {
    // The endpoints need not share a turf, and each is scored against
    // its own prefix: a grant writing /rw but only reading /ro refuses,
    // blaming the destination, the way the backend gate checks both ends
    // of a rename. The grant is what binds, so both mounts are writable
    // and the session is the only thing narrowing either.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/rw': new RAMVFS(), '/ro': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
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
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
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
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
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
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/ram': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
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
    const parser = await getTestParser()
    class BrokenVFS extends RAMVFS {
      override stat(): Promise<FileStat> {
        return Promise.reject(new Error('401 bad credentials'))
      }
    }
    const broken = new BrokenVFS()
    const ws = new Workspace(
      { '/r': new RAMVFS(), '/data': broken },
      { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
    )
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
    const parser = await getTestParser()
    const listing = new RAMVFS()
    // The store's key iteration is reached only by the parent readdir, not
    // by the stat probe ahead of it, so this fails exactly the one channel.
    vi.spyOn(listing.store.files, 'keys').mockImplementation(() => {
      throw new Error('backend listing failed')
    })
    const ws = new Workspace(
      { '/r': new RAMVFS(), '/data': listing },
      { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
    )
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
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/r': new RAMVFS() },
      { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await expect(ws.dispatch('readlink', '/nowhere/x')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ws.close()
    }
  }, 30_000)
})

describe('the dispatcher answers extended attributes from the node table', () => {
  const open = async (): Promise<Workspace> => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/r': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
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
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/ro': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser },
    )
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

describe('rmdir namespace entries', () => {
  it.each([false, true])(
    'accounts for a directory containing only a link (hidden=%s)',
    async (hidden) => {
      const parser = await getTestParser()
      const ws = new Workspace(
        { '/data': new RAMVFS() },
        { mode: MountMode.WRITE, shellParser: parser },
      )
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

  it('keeps a link created while the backend removes the directory', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser },
    )
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
    const ws = new Workspace(
      { '/data': vfs },
      { mode: MountMode.WRITE, shellParserFactory: getTestParser },
    )
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
    expect(await ws.vfs.cat('/data/f.count')).toBe('BODY')
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
    expect(await ws.vfs.cat('/data/f.count')).toBe('NEWER')
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
      // rendering must not become what cat reads. A ranged read on a store
      // with no native range fills the whole file too.
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
      expect(DEC.decode((await ws.shell('cat /data/f.count')).stdout)).toBe('STORED')
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
      check: (virtual: string): void => {
        asked.push(virtual)
        if (virtual === refused) throw new Error(`sealed ${virtual}`)
      },
      refuses: (virtual: string): boolean => virtual === refused,
    },
  }
}

// A workspace with a linked directory and a link to a file inside it.
async function linkedWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
  )
  await ws.shell(
    'mkdir -p /data/real && echo s > /data/real/secret && ' +
      'ln -s /data/real /data/alias && ln -s /data/real/secret /data/flink',
  )
  return ws
}

const text = async (ws: Workspace, virtual: string): Promise<string> =>
  new TextDecoder().decode((await ws.dispatch('read', virtual)) as Uint8Array)

const spec = (virtual: string): PathSpec => PathSpec.fromStrPath(virtual)

describe('a marked op is judged on the paths the dispatcher reaches', () => {
  // Each spelling once, in the order the dispatcher meets it: as handed in,
  // walked, then followed. A refused op leaves the bytes alone; an unmarked
  // one is the dispatcher's alone.
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
        await expect(ws.dispatch(op, virtual, args, { ...kwargs, ruleGate: gate })).rejects.toThrow(
          'sealed',
        )
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
      await expect(
        ws.dispatch('read', '/data/alias/flink2', [], { ruleGate: walked.gate }),
      ).rejects.toThrow('sealed')
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
        ws.dispatch('unlink', '/data/flink', [], { ruleGate: refusing('/data/flink').gate }),
      ).rejects.toThrow('sealed')
      const referent = refusing('/data/real/secret')
      await ws.dispatch('unlink', '/data/flink', [], { ruleGate: referent.gate })
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
          await expect(ws.dispatch(op, virtual, args, { ruleGate: gate })).rejects.toMatchObject({
            code: 'ENOENT',
          })
        }
      })
      expect(asked).toEqual([])
    } finally {
      await ws.close()
    }
  })

  // The dispatcher lifts the mark at entry: the mount's op sees only its own
  // arguments. A null mark is no mark, as Python's rule_gate=None.
  it('never forwards the mark to the op', async () => {
    const ws = await linkedWs()
    const spy = vi.spyOn(MountEntry.prototype, 'callKeyed')
    try {
      const { gate, asked } = refusing('/nothing')
      await ws.dispatch('read', '/data/real/secret', [], { ruleGate: gate })
      const seen = spy.mock.calls.map((call) => call[3])
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((kw) => kw === undefined || !('ruleGate' in kw))).toBe(true)
      expect(asked).toEqual(['/data/real/secret'])
      const read = await ws.dispatch('read', '/data/real/secret', [], { ruleGate: null })
      expect(new TextDecoder().decode(read as Uint8Array)).toBe('s\n')
    } finally {
      spy.mockRestore()
      await ws.close()
    }
  })
})

/**
 * A RAM mount that answers pwrite the way S3 and redis do: read the file,
 * give the loop a turn, and write the whole file back.
 */
class SplicingRAMVFS extends RAMVFS {
  constructor(private readonly pause = 0) {
    super()
  }

  override async pwrite(path: PathSpec, data: Uint8Array, offset: number): Promise<void> {
    const whole = await this.read(path)
    await new Promise((resolve) => setTimeout(resolve, this.pause))
    await this.write(path, spliceWindow(whole, offset, data))
  }
}

/** A RAM mount whose one op never answers until the test releases it. */
class StalledRAMVFS extends RAMVFS {
  calls = 0
  release = (): void => undefined

  constructor(stalled = 'pwrite') {
    super()
    Object.assign(this, {
      [stalled]: () => {
        this.calls += 1
        return new Promise<void>((resolve) => {
          this.release = resolve
        })
      },
    })
  }
}

describe('dispatch runs writers to one path one at a time', () => {
  it('lands every offset write on a store that splices', async () => {
    // Four sessions' edits at once: each pwrite reads the file before any
    // writes it back, so without one writer at a time per path every
    // write puts back three bytes the others had just replaced. Mirrors
    // python's test_offset_writes_to_one_path_all_land_on_a_splicing_store.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new SplicingRAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
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
    const parser = await getTestParser()
    const store = new SplicingRAMVFS()
    const ws = new Workspace(
      { '/a': store, '/b': store },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
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

  it('times out a writer queued behind a call that never answers', async () => {
    // The stalled call keeps the path, since it may still write; a writer
    // queued behind it times out on its own budget and then never runs.
    const store = new StalledRAMVFS()
    const parser = await getTestParser()
    const ws = new Workspace(
      {
        '/data': [store, MountMode.WRITE, { pwrite: new Limit({ timeoutSeconds: 0.01 }) }],
      },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.dispatch('write', '/data/f', [ENC.encode('0123456789')])
      await expect(ws.dispatch('pwrite', '/data/f', [ENC.encode('A'), 0])).rejects.toThrow()
      await expect(ws.dispatch('pwrite', '/data/f', [ENC.encode('B'), 3])).rejects.toThrow()
      store.release()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(store.calls).toBe(1)
    } finally {
      store.release()
      await ws.close()
    }
  })

  it('lets an unmount go ahead once a stalled write has timed out', async () => {
    // The hold outlives the timeout, the mount's activity does not: a store
    // call that never answers must not keep the store from being removed.
    const store = new StalledRAMVFS()
    const parser = await getTestParser()
    const ws = new Workspace(
      {
        '/data': [store, MountMode.WRITE, { pwrite: new Limit({ timeoutSeconds: 0.01 }) }],
        '/other': new RAMVFS(),
      },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.dispatch('write', '/data/f', [ENC.encode('0123456789')])
      await expect(ws.dispatch('pwrite', '/data/f', [ENC.encode('A'), 0])).rejects.toThrow()
      await ws.unmount('/data')
      expect(store.calls).toBe(1)
    } finally {
      store.release()
      await ws.close()
    }
  })

  it('keeps a late call off a mount that replaced its own', async () => {
    // By the time a timed-out rename lands, its mount may be gone and
    // another store mounted at the prefix: the late call must not touch
    // the new mount's links.
    const store = new StalledRAMVFS('rename')
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': [store, MountMode.WRITE, { rename: new Limit({ timeoutSeconds: 0.01 }) }] },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.dispatch('write', '/data/a', [ENC.encode('a')])
      await expect(
        ws.dispatch('rename', '/data/a', [PathSpec.fromStrPath('/data/b')]),
      ).rejects.toThrow()
      await ws.unmount('/data')
      ws.addMount('/data', new RAMVFS(), MountMode.WRITE)
      await ws.dispatch('symlink', '/data/b', [], { target: 'x' })
      store.release()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(ws.namespace.isLink('/data/b')).toBe(true)
    } finally {
      store.release()
      await ws.close()
    }
  })

  it('keeps a late rename off a mount now over its destination', async () => {
    // The source's mount stays, but a mount added under the destination
    // after the timeout owns that name now: the late rename must not touch
    // its links.
    const store = new StalledRAMVFS('rename')
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': [store, MountMode.WRITE, { rename: new Limit({ timeoutSeconds: 0.01 }) }] },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.dispatch('write', '/data/a', [ENC.encode('a')])
      await ws.dispatch('mkdir', '/data/sub')
      await expect(
        ws.dispatch('rename', '/data/a', [PathSpec.fromStrPath('/data/sub/b')]),
      ).rejects.toThrow()
      ws.addMount('/data/sub', new RAMVFS(), MountMode.WRITE)
      await ws.dispatch('symlink', '/data/sub/b', [], { target: 'x' })
      store.release()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(ws.namespace.isLink('/data/sub/b')).toBe(true)
    } finally {
      store.release()
      await ws.close()
    }
  })

  it('lets go of a name when a rename gives up waiting for the other', async () => {
    // The rename holds /data/f and waits for /data/g, which a stalled
    // pwrite keeps; once the rename times out, /data/f is free again.
    const store = new StalledRAMVFS()
    const parser = await getTestParser()
    const limit = new Limit({ timeoutSeconds: 0.01 })
    const ws = new Workspace(
      { '/data': [store, MountMode.WRITE, { pwrite: limit, rename: limit }] },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.dispatch('write', '/data/f', [ENC.encode('f')])
      await ws.dispatch('write', '/data/g', [ENC.encode('g')])
      await expect(ws.dispatch('pwrite', '/data/g', [ENC.encode('G'), 0])).rejects.toThrow()
      await expect(
        ws.dispatch('rename', '/data/f', [PathSpec.fromStrPath('/data/g')]),
      ).rejects.toThrow()
      await ws.dispatch('write', '/data/f', [ENC.encode('after')])
      expect(DEC.decode((await ws.dispatch('read', '/data/f')) as Uint8Array)).toBe('after')
    } finally {
      store.release()
      await ws.close()
    }
  })

  it('reports a call that fails after its timeout', async () => {
    // The caller already has its timeout, so the store's own failure
    // reaches no one else: it is reported, not dropped.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    class LateFailingRAMVFS extends RAMVFS {
      override async pwrite(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('store went away')
      }
    }
    const parser = await getTestParser()
    const ws = new Workspace(
      {
        '/data': [
          new LateFailingRAMVFS(),
          MountMode.WRITE,
          { pwrite: new Limit({ timeoutSeconds: 0.01 }) },
        ],
      },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.dispatch('write', '/data/f', [ENC.encode('0123456789')])
      await expect(ws.dispatch('pwrite', '/data/f', [ENC.encode('A'), 0])).rejects.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('store went away')
    } finally {
      warn.mockRestore()
      await ws.close()
    }
  })

  it('holds the path past a timeout until the store has answered', async () => {
    // A timeout rejects the caller but cannot stop the call: the timed-out
    // pwrite still writes back what it read, so the next writer (a whole
    // write, which has no timeout) must land after it, not under it.
    const parser = await getTestParser()
    const ws = new Workspace(
      {
        '/data': [
          new SplicingRAMVFS(50),
          MountMode.WRITE,
          { pwrite: new Limit({ timeoutSeconds: 0.01 }) },
        ],
      },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.dispatch('write', '/data/f', [ENC.encode('0123456789')])
      await expect(ws.dispatch('pwrite', '/data/f', [ENC.encode('A'), 0])).rejects.toThrow()
      await ws.dispatch('write', '/data/f', [ENC.encode('XXXXXXXXXX')])
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(DEC.decode((await ws.dispatch('read', '/data/f')) as Uint8Array)).toBe('XXXXXXXXXX')
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

  override readdir(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()].map((name) => `/tape/${name}`))
  }

  override stat(path: PathSpec): Promise<FileStat> {
    const key = path.vfsPath.replace(/^\/+/, '')
    if (key === '') return Promise.resolve(new FileStat({ name: '/', type: FileType.DIRECTORY }))
    const data = this.files.get(key)
    if (data === undefined) return Promise.reject(enoent(path))
    return Promise.resolve(new FileStat({ name: key, type: FileType.FILE, size: data.byteLength }))
  }

  override read(path: PathSpec): Promise<Uint8Array> {
    this.reads += 1
    const data = this.files.get(path.vfsPath.replace(/^\/+/, ''))
    return data === undefined ? Promise.reject(enoent(path)) : Promise.resolve(data)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    this.files.set(path.vfsPath.replace(/^\/+/, ''), data)
    return Promise.resolve()
  }

  override async *readStream(path: PathSpec): AsyncIterable<Uint8Array> {
    const data = this.files.get(path.vfsPath.replace(/^\/+/, ''))
    if (data === undefined) throw enoent(path)
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
      expect(tape.reads).toBe(0)
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
      expect(tape.pulled).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('gives each pull the whole timeout', async () => {
    const tape = new Tape()
    tape.delay = 50
    const ws = new Workspace(
      { '/tape': [tape, MountMode.WRITE, { read: new Limit({ timeoutSeconds: 0.2 }) }] },
      { mode: MountMode.WRITE },
    )
    try {
      const stream = await ws.dispatch('read', TAPE, [], { stream: true })
      const got: Uint8Array[] = []
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        got.push(chunk)
        await sleep(100)
      }
      expect(got).toHaveLength(5)
      tape.files.set('b.txt', tape.files.get('a.txt') ?? new Uint8Array())
      tape.delay = 500
      await expect(
        ws.dispatch('read', '/tape/b.txt', [], { stream: true, filetype: null }),
      ).rejects.toBeInstanceOf(CommandTimeoutError)
    } finally {
      await ws.close()
    }
  })

  it.each([OnExceed.TRUNCATE, OnExceed.ERROR])('stops at the cap (%s)', async (onExceed) => {
    const tape = new Tape()
    const ws = new Workspace(
      { '/tape': [tape, MountMode.WRITE, { read: new Limit({ maxBytes: 15, onExceed }) }] },
      { mode: MountMode.WRITE },
    )
    try {
      const stream = await ws.dispatch('read', TAPE, [], { stream: true, filetype: null })
      let got = ''
      const pull = async (): Promise<void> => {
        for await (const chunk of stream as AsyncIterable<Uint8Array>) got += DEC.decode(chunk)
      }
      if (onExceed === OnExceed.ERROR)
        await expect(pull()).rejects.toBeInstanceOf(LimitExceededError)
      else await pull()
      expect(got).toBe('012345678901234')
      expect(tape.pulled).toBe(2)
    } finally {
      await ws.close()
    }
  })

  it.each([[null], [new Limit({ maxBytes: 15 })]])(
    'closes and keeps nothing when closed before its first pull (cap %o)',
    async (cap) => {
      const tape = new Tape()
      const ws = new Workspace(
        { '/tape': cap === null ? tape : [tape, MountMode.WRITE, { read: cap }] },
        { mode: MountMode.WRITE },
      )
      try {
        const stream = (await ws.dispatch('read', TAPE, [], {
          stream: true,
        })) as AsyncGenerator<Uint8Array>
        await stream.return(undefined)
        expect([tape.pulled, tape.closed]).toEqual([1, true])
        await ws.dispatch('read', TAPE)
        expect(tape.reads).toBe(1)
      } finally {
        await ws.close()
      }
    },
  )

  it('keeps none of itself when a write lands during it', async () => {
    const tape = new Tape()
    const ws = new Workspace({ '/tape': tape }, { mode: MountMode.WRITE })
    try {
      const stream = await ws.dispatch('read', TAPE, [], { stream: true })
      await ws.dispatch('write', TAPE, [ENC.encode('new')])
      expect((await pullAll(stream))[0]).toBe('0123456789')
      expect(DEC.decode((await ws.dispatch('read', TAPE)) as Uint8Array)).toBe('new')
      expect(tape.reads).toBe(0)
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
      expect(tape.reads).toBe(1)
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
    const seen: [string, string][] = []
    const policy: Policy = {
      preVfs: (ctx: VfsContext) => {
        seen.push([ctx.op, ctx.path.virtual])
        return null
      },
    }
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/d': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        policies: [policy],
        shellParserFactory: () => Promise.resolve(parser),
      },
    )
    try {
      await ws.vfs.write('/d/a.txt', 'a\nb\n')
      seen.length = 0
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
