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

import { describe, expect, it } from 'vitest'
import { runWithSession } from '../../context/session_context.ts'
import { revisionFor } from '../../observe/context.ts'
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { Limit, MountMode, PathSpec } from '../../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Session } from '../session/session.ts'
import { Workspace } from '../workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe('dispatch applies limits on the executing mount', () => {
  it('a symlink into a limited mount gets the target mount limit', async () => {
    const parser = await getTestParser()
    const data = new RAMResource()
    const plain = new RAMResource()
    const ws = new Workspace(
      {
        '/data': [data, MountMode.EXEC, { read: new Limit({ maxBytes: 8 }) }],
        '/r': plain,
      },
      { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.execute('echo 0123456789abcdef > /data/big.txt')
      await ws.execute('ln -s /data/big.txt /r/link')
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

describe('a fresh read refuses the warm file cache', () => {
  // Ops.readFileWithIdentity needs the backend's own answer: a cached
  // read stamps no fingerprint or revision, so serving one would report
  // a versioned file as having no identity. Mirrors Python's
  // tests/workspace/dispatcher/test_dispatcher.py.
  function mkCaching(): Workspace {
    const resource = new RAMResource()
    Object.assign(resource, { cachesReads: true })
    const ops = new OpsRegistry()
    ops.registerResource(resource)
    return new Workspace({ '/m': resource }, { mode: MountMode.WRITE, ops })
  }

  it('serves the backend bytes where a plain read serves the cache', async () => {
    const ws = mkCaching()
    await ws.fs.writeFile('/m/f.txt', 'STORED')
    await ws.cache.set('/m/f.txt', ENC.encode('CACHED'))
    expect(DEC.decode((await ws.dispatch('read', '/m/f.txt')) as Uint8Array)).toBe('CACHED')
    const fresh = (await ws.dispatch('read', '/m/f.txt', [], { fresh: true })) as Uint8Array
    expect(DEC.decode(fresh)).toBe('STORED')
  })

  it('is consumed at the door and never forwarded to the backend', async () => {
    // No backend declares it, so a leaked flag would reach the op fn.
    const resource = new RAMResource()
    Object.assign(resource, { cachesReads: true })
    const ops = new OpsRegistry()
    ops.registerResource(resource)
    const ws = new Workspace({ '/m': resource }, { mode: MountMode.WRITE, ops })
    let seen: string[] = []
    ops.register({
      name: 'read',
      resource: resource.kind,
      filetype: null,
      fn: (_accessor, _path, _args, kwargs) => {
        seen = Object.keys(kwargs)
        return ENC.encode('STORED')
      },
      write: false,
    })
    await ws.dispatch('read', '/m/f.txt', [], { fresh: true })
    expect(seen).not.toContain('fresh')
  })
})

describe('dispatch rename addresses dst against the source mount', () => {
  it('cross-mount dst is refused like Python refuses it (EXDEV is a follow-up)', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMResource(), '/b': new RAMResource() },
      { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.execute('echo moved-bytes > /a/x.txt')
      // Both languages execute the rename on the source backend and address
      // the dst key against it, so '/b/y.txt' means 'b/y.txt' inside /a, a
      // directory that does not exist there. The store-backed backends
      // refuse (rename(2) ENOENT) instead of growing an orphan key under a
      // directory they never recorded. Neither language crosses mounts.
      await expect(
        ws.dispatch('rename', '/a/x.txt', [PathSpec.fromStrPath('/b/y.txt')]),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(DEC.decode((await ws.execute('cat /a/x.txt')).stdout)).toBe('moved-bytes\n')
      expect((await ws.execute('cat /a/b/y.txt')).exitCode).not.toBe(0)
      expect((await ws.execute('cat /b/y.txt')).exitCode).not.toBe(0)
    } finally {
      await ws.close()
    }
  }, 30_000)
})

describe('dispatch resolves filetype-registered ops by path extension', () => {
  it('a read op keyed to a rendered filetype wins over the plain read', async () => {
    // gdocs/gsheets/gslides/gmail register their rendered reads under a
    // compound filetype; Python reaches them because its dispatcher goes
    // through Mount.execute_op, which stamps the extension. The TS
    // dispatcher must stamp it the same way or every dispatch-based path
    // (crossmount relay, FUSE) misses the op.
    const parser = await getTestParser()
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    registry.register({
      name: 'read',
      resource: 'ram',
      filetype: '.gdoc.json',
      write: false,
      fn: () => Promise.resolve(ENC.encode('rendered')),
    })
    const ws = new Workspace(
      { '/m': ram },
      { mode: MountMode.EXEC, ops: registry, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.execute('echo raw > /m/doc.gdoc.json')
      const bytes = (await ws.dispatch('read', '/m/doc.gdoc.json')) as Uint8Array
      expect(DEC.decode(bytes)).toBe('rendered')
    } finally {
      await ws.close()
    }
  }, 30_000)
})

describe('unlink of a namespace link', () => {
  it('removes the link, which no backend can see', async () => {
    // The door creates links (`symlink`), so it has to remove them too: a
    // link has no backend entry, so forwarding the unlink reaches a backend
    // that has never heard of the name and answers ENOENT, leaving the link
    // in place. That is what left `git checkout` unable to drop a link the
    // other branch does not have.
    const parser = await getTestParser()
    const ram = new RAMResource()
    const ws = new Workspace(
      { '/ram': ram },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.execute('echo hi > /ram/a.txt')
      await ws.execute('ln -s a.txt /ram/link')
      await ws.dispatch('unlink', '/ram/link')
      const listing = await ws.execute('ls /ram')
      expect(DEC.decode(listing.stdout)).not.toContain('link')
    } finally {
      await ws.close()
    }
  })

  it('still reaches the backend for an ordinary file', async () => {
    const parser = await getTestParser()
    const ram = new RAMResource()
    const ws = new Workspace(
      { '/ram': ram },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.execute('echo hi > /ram/a.txt')
      await ws.dispatch('unlink', '/ram/a.txt')
      const listing = await ws.execute('ls /ram')
      expect(DEC.decode(listing.stdout).trim()).toBe('')
    } finally {
      await ws.close()
    }
  })
})

describe('the node table answers every verb that names a link', () => {
  async function linkWorkspace(): Promise<Workspace> {
    const parser = await getTestParser()
    const ram = new RAMResource()
    const ws = new Workspace(
      { '/ram': ram },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    await ws.execute('echo hi > /ram/a.txt')
    await ws.execute('mkdir /ram/d')
    await ws.execute('ln -s a.txt /ram/link')
    return ws
  }

  it('renames the link, which no backend can see', async () => {
    // Same fact as the unlink above, one verb along: a guest's rename of
    // a link forwarded to a backend that had never heard of the name, so
    // it answered ENOENT with the link still under the old one.
    const ws = await linkWorkspace()
    try {
      await ws.dispatch('rename', '/ram/link', [PathSpec.fromStrPath('/ram/moved')])
      expect(DEC.decode((await ws.execute('readlink /ram/moved')).stdout)).toBe('a.txt\n')
      expect((await ws.execute('readlink /ram/link')).exitCode).toBe(1)
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
      expect(DEC.decode((await ws.execute('cat /ram/link')).stdout)).toBe('hi\n')
      expect((await ws.execute('readlink /ram/link')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('refuses a symlink onto a name that is taken', async () => {
    // symlink(2) is EEXIST on an occupied name, and only the door can
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
      expect(DEC.decode((await ws.execute('cat /ram/a.txt')).stdout)).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })
})

describe('the fenced remnant cascade rides the mount revisions', () => {
  it('a fenced backend op reads the pinned revision', async () => {
    // fencedCall reruns backend ops outside `dispatch`, and Python's
    // twin routes them through `Mount.execute_op`, which binds the
    // mount prefix AND the revision pins. A fenced readdir/stat that
    // reads unpinned answers from the wrong version of a
    // revision-pinned mount, so the binding is pinned here through the
    // one public trigger: an rmdir whose only remnants the session
    // cannot see.
    const parser = await getTestParser()
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace(
      { '/ram': ram },
      { mode: MountMode.WRITE, ops: registry, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.execute('mkdir /ram/d && echo x > /ram/d/h.txt')
      // Mounting re-registers the resource's ops (workspace.ts), so the
      // probe wraps readdir only after construction, or it is clobbered.
      const original = registry.find('readdir', 'ram')
      if (original === null) throw new Error('ram readdir op missing')
      const originalFn = original.fn
      let seen: string | null | undefined
      registry.register({
        ...original,
        fn: (...args: Parameters<typeof originalFn>) => {
          seen = revisionFor('/ram/d/h.txt')
          return originalFn(...args)
        },
      })
      const internals = ws as unknown as {
        registry: { mountFor(path: string): { revisions: Map<string, string> } }
      }
      internals.registry.mountFor('/ram/d').revisions.set('/ram/d/h.txt', 'r1')
      const sess = new Session({
        sessionId: 'agent',
        hiddenPaths: { paths: ['/ram/d/h.txt'] },
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
      { '/extra': new RAMResource() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.execute('echo b > /extra/plain.txt')
      await ws.execute('ln -s plain.txt /extra/lk')
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
      expect(DEC.decode((await ws.execute('readlink /extra/lk')).stdout)).toBe('plain.txt\n')
      expect((await ws.execute('readlink /extra/lk2')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('a read mount still takes a link sessionless', async () => {
    // The mount's own mode is NOT this gate. `mode: read` says the
    // backend cannot write, and a symlink is namespace state needing no
    // write capability from it -- which is why a link above postgres,
    // mongodb, chroma and qdrant (all mounted read) is pinned working in
    // integ/resources/<svc>/sym.json. Only a session grant binds here.
    const ws = new Workspace({ '/ro': [new RAMResource(), MountMode.READ] })
    try {
      await ws.dispatch('symlink', '/ro/lk', [], { target: 't' })
      expect(ws.namespace.isLink('/ro/lk')).toBe(true)
      // And the backend write on that same mount is still refused, so
      // the two planes are told apart rather than both waved through.
      await expect(
        ws.dispatch('write', '/ro/f.txt', [], { data: ENC.encode('x') }),
      ).rejects.toMatchObject({ code: 'EROFS' })
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
      { '/rw': new RAMResource(), '/ro': new RAMResource() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.execute('ln -s t /rw/lk')
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
