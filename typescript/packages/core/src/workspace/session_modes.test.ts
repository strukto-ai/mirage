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

import { afterEach, describe, expect, it } from 'vitest'
import { runWithSession } from '../context/session_context.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMSessionStore } from './session/ram.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { FileType, MountMode, type FileStat } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { parseSessionProfile } from '../policy/profile.ts'
import { Workspace } from './workspace/workspace.ts'

const ENC = new TextEncoder()

interface GrantsWorkspace {
  ws: Workspace
  a: RAMVFS
  b: RAMVFS
  root: RAMVFS | null
}

const open: Workspace[] = []

async function makeGrantsWorkspace(
  options: { rootMount?: boolean; modes?: Record<string, MountMode> } = {},
): Promise<GrantsWorkspace> {
  const parser = await getTestParser()
  const a = new RAMVFS()
  const b = new RAMVFS()
  a.store.files.set('/x.txt', ENC.encode('hi\n'))
  b.store.files.set('/secret.txt', ENC.encode('SECRET\n'))
  const mounts: Record<string, RAMVFS> = { '/a': a, '/b': b }
  let root: RAMVFS | null = null
  if (options.rootMount === true) {
    root = new RAMVFS()
    root.store.files.set('/root.txt', ENC.encode('top\n'))
    mounts['/'] = root
  }
  const registry = new OpsRegistry()
  for (const r of Object.values(mounts)) registry.registerVfs(r)
  const modes = options.modes ?? {}
  const specs = Object.fromEntries(
    Object.entries(mounts).map(([prefix, r]) => [
      prefix,
      modes[prefix] !== undefined ? ([r, modes[prefix]] as const) : r,
    ]),
  )
  const ws = new Workspace(specs, {
    mode: MountMode.WRITE,
    ops: registry,
    shellParser: parser,
  })
  open.push(ws)
  return { ws, a, b, root }
}

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

describe('per-session mount grants', () => {
  it('read grant blocks command writes but allows reads', async () => {
    const { ws, a } = await makeGrantsWorkspace()
    ws.createSession('agent', { mounts: { '/a': MountMode.READ } })

    const ok = await ws.shell('cat /a/x.txt', { sessionId: 'agent' })
    expect(ok.exitCode).toBe(0)
    expect(stdoutStr(ok)).toContain('hi')

    const denied = await ws.shell('rm /a/x.txt', { sessionId: 'agent' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toBe("rm: cannot remove '/a/x.txt': Read-only file system\n")
    expect(a.store.files.has('/x.txt')).toBe(true)
  })

  it('read grant blocks redirect writes', async () => {
    const { ws, a } = await makeGrantsWorkspace()
    ws.createSession('agent', { mounts: { '/a': MountMode.READ } })

    const denied = await ws.shell('echo leaked > /a/y.txt', { sessionId: 'agent' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toBe('/a/y.txt: Read-only file system\n')
    expect(a.store.files.has('/y.txt')).toBe(false)
  })

  // A hidden mount takes a shell-attributed line like a READ-granted
  // one, on `>` and `>>` alike, and the rest of the line keeps running.
  // The mount does not exist for the session, so a create under it
  // answers ENOENT as every read does, rather than an EACCES that would
  // let the session map the hide by probing writes.
  it.each(['echo leaked > /b/y.txt; echo next', 'echo leaked >> /b/y.txt; echo next'])(
    'shell-attributes %s for a hidden mount',
    async (line) => {
      const { ws, b } = await makeGrantsWorkspace()
      ws.createSession('agent', { profile: { paths: { hide: ['/b'] } } })

      const denied = await ws.shell(line, { sessionId: 'agent' })
      expect(denied.exitCode).toBe(0)
      expect(stdoutStr(denied)).toBe('next\n')
      expect(stderrStr(denied)).toBe('/b/y.txt: No such file or directory\n')
      expect(b.store.files.has('/y.txt')).toBe(false)
    },
  )

  it('write grant allows writes', async () => {
    const { ws, a } = await makeGrantsWorkspace()
    ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })

    const io = await ws.shell('echo new > /a/y.txt', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(a.store.files.has('/y.txt')).toBe(true)
  })

  it('grant cannot widen a READ mount', async () => {
    const { ws } = await makeGrantsWorkspace({ modes: { '/a': MountMode.READ } })
    ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })

    const denied = await ws.shell('echo up > /a/y.txt', { sessionId: 'agent' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toBe('/a/y.txt: Read-only file system\n')
  })

  // A list used to mean "only these mounts are reachable"; a mount a profile
  // does not name now keeps its own mode, so the list would quietly drop
  // the confinement it used to carry.
  it('refuses a bare list of mounts', async () => {
    const { ws } = await makeGrantsWorkspace()
    expect(() =>
      ws.createSession('agent', { mounts: ['/a'] as unknown as Record<string, unknown> }),
    ).toThrow('mounts must be a mapping of prefix to its settings')
  })

  it('a mount the profile does not name stays reachable', async () => {
    // The behavior change worth pinning: naming one mount is not an
    // allowlist over the rest.
    const { ws } = await makeGrantsWorkspace()
    ws.createSession('agent', { mounts: { '/a': MountMode.READ } })

    const io = await ws.shell('cat /b/secret.txt', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('SECRET')
  })

  it('a hidden mount reads as absent', async () => {
    // A profile narrows the mounts it names and never decides whether one
    // exists, so keeping a session away from a mount is a hide, and a
    // hide answers ENOENT: naming the mount in a refusal would confirm
    // to the agent exactly what it was not meant to know is there.
    const { ws } = await makeGrantsWorkspace()
    ws.createSession('agent', { profile: { paths: { hide: ['/b'] } } })

    const denied = await ws.shell('cat /b/secret.txt', { sessionId: 'agent' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toBe('cat: /b/secret.txt: No such file or directory\n')
    expect(stdoutStr(denied)).not.toContain('SECRET')

    const listed = await ws.shell('ls /', { sessionId: 'agent' })
    expect(stdoutStr(listed).split(/\s+/)).not.toContain('b')
  })

  it('a user-defined root mount is governed like any other', async () => {
    const { ws } = await makeGrantsWorkspace({ rootMount: true })
    ws.createSession('no_root', {
      profile: parseSessionProfile({
        mounts: { '/a': MountMode.WRITE },
        paths: { hide: ['/root.txt'] },
      }),
    })
    ws.createSession('root_ro', { mounts: { '/a': MountMode.WRITE, '/': MountMode.READ } })

    const denied = await ws.shell('cat /root.txt', { sessionId: 'no_root' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('No such file or directory')

    const readOk = await ws.shell('cat /root.txt', { sessionId: 'root_ro' })
    expect(readOk.exitCode).toBe(0)
    expect(stdoutStr(readOk)).toContain('top')

    const writeDenied = await ws.shell('echo x > /root.txt', { sessionId: 'root_ro' })
    expect(writeDenied.exitCode).not.toBe(0)
    expect(stderrStr(writeDenied)).toBe('/root.txt: Read-only file system\n')
  })

  it('the implicit scratch root keeps pathless commands working', async () => {
    const { ws } = await makeGrantsWorkspace()
    ws.createSession('agent', { mounts: { '/a': MountMode.READ } })

    const io = await ws.shell('echo hi | wc -l', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io).trim()).toBe('1')
  })

  it('rejects invalid profiles', async () => {
    const { ws } = await makeGrantsWorkspace()
    expect(() => ws.createSession('agent', { mounts: { '/a': 'admin' as MountMode } })).toThrow(
      'invalid mount mode',
    )
  })

  it('accepts filesystem alias profiles, rejects bit-style forms', async () => {
    const { ws } = await makeGrantsWorkspace()
    const sess = ws.createSession('agent', { mounts: { '/a': 'rw' } })
    expect(sess.mountModes?.get('/a')).toBe(MountMode.WRITE)
    expect(() => ws.createSession('bits', { mounts: { '/a': 'w' } })).toThrow('invalid mount mode')
  })
})

describe('structure below a mount whose own content is hidden', () => {
  async function makeNestedWorkspace(): Promise<Workspace> {
    const parser = await getTestParser()
    const base = new RAMVFS()
    base.store.files.set('/top.txt', ENC.encode('TOP\n'))
    const inner = new RAMVFS()
    inner.store.files.set('/deep.txt', ENC.encode('needle\n'))
    const registry = new OpsRegistry()
    registry.registerVfs(base)
    registry.registerVfs(inner)
    const ws = new Workspace(
      { '/base': base, '/base/inner': inner },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    open.push(ws)
    return ws
  }

  it('a session can still walk down to the nested mount', async () => {
    // The root listing shows `base` as the traversal path to the nested
    // mount, so readdir and stat on /base answer with the structure; the
    // parent's own hidden content never appears, and a hidden path below
    // it reads as absent rather than as a refusal naming it.
    const ws = await makeNestedWorkspace()
    const sess = ws.createSession('agent', {
      profile: { paths: { hide: ['/base/top.txt', '/base/other'] } },
    })
    await runWithSession(sess, async () => {
      expect(await ws.dispatch('readdir', '/base')).toEqual(['/base/inner'])
      const st = (await ws.dispatch('stat', '/base')) as FileStat
      expect(st.type).toBe(FileType.DIRECTORY)
      expect(await ws.dispatch('readdir', '/base/inner')).toEqual(['/base/inner/deep.txt'])
      await expect(ws.dispatch('readdir', '/base/other')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })

  it('a link below a hidden mount stays out of a scoped listing', async () => {
    const { ws } = await makeGrantsWorkspace()
    const ln = await ws.shell('ln -s /b/secret.txt /b/leak')
    expect(ln.exitCode).toBe(0)
    const sess = ws.createSession('agent', { profile: { paths: { hide: ['/b'] } } })
    await runWithSession(sess, async () => {
      const names = (await ws.dispatch('readdir', '/')) as string[]
      expect(names).not.toContain('/b')
      expect(names).toContain('/a')
    })
    expect((await ws.dispatch('readdir', '/')) as string[]).toContain('/b')
  })
})

describe('sessions on a shared SessionStore', () => {
  it('a session created by one workspace narrows a sibling on the same store', async () => {
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const store = new RAMSessionStore()
    const wsA = new Workspace(
      { '/data': ram },
      { mode: MountMode.EXEC, shellParser: parser, sessionStore: store },
    )
    open.push(wsA)
    wsA.createSession('narrow', { mounts: { '/data': MountMode.READ } })
    await wsA.flushSessions()

    const wsB = new Workspace(
      { '/data': ram },
      { mode: MountMode.EXEC, shellParser: parser, sessionStore: store },
    )
    open.push(wsB)
    const denied = await wsB.shell('echo blocked > /data/x.txt', { sessionId: 'narrow' })
    expect(denied.exitCode).not.toBe(0)
  })
})

describe('nested mount disclosure', () => {
  // `tree` crosses a boundary from the mount table alone: a crossing
  // entry's row is synthesized as a directory without asking any
  // backend, so the dispatcher never sees it and cannot refuse it.
  // Before the session filter, `tree /base` drew `private` and counted
  // it, while `ls`, `find` and `du` on the same tree all hid it.
  async function makeNested(): Promise<Workspace> {
    const parser = await getTestParser()
    const base = new RAMVFS()
    const priv = new RAMVFS()
    base.store.files.set('/top.txt', ENC.encode('public\n'))
    priv.store.files.set('/secret.txt', ENC.encode('SECRET\n'))
    const registry = new OpsRegistry()
    for (const r of [base, priv]) registry.registerVfs(r)
    const ws = new Workspace(
      { '/base': base, '/base/private': priv },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    open.push(ws)
    return ws
  }

  it('tree does not disclose a hidden nested mount', async () => {
    const ws = await makeNested()
    ws.createSession('agent', { profile: { paths: { hide: ['/base/private'] } } })

    const io = await ws.shell('tree /base', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).not.toContain('private')
    expect(stdoutStr(io)).toBe('/base\n`-- top.txt\n\n1 directory, 1 file\n')
  })

  it('tree still crosses a visible nested mount', async () => {
    // The filter must not cost a session the mounts it can see.
    const ws = await makeNested()
    ws.createSession('agent', { mounts: { '/base': MountMode.READ } })

    const io = await ws.shell('tree /base', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe(
      '/base\n|-- private\n|   `-- secret.txt\n`-- top.txt\n\n2 directories, 2 files\n',
    )
  })
})
