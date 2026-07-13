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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()

interface GrantsWorkspace {
  ws: Workspace
  a: RAMResource
  b: RAMResource
  root: RAMResource | null
}

const open: Workspace[] = []

async function makeGrantsWorkspace(
  options: { rootMount?: boolean; modes?: Record<string, MountMode> } = {},
): Promise<GrantsWorkspace> {
  const parser = await getTestParser()
  const a = new RAMResource()
  const b = new RAMResource()
  a.store.files.set('/x.txt', ENC.encode('hi\n'))
  b.store.files.set('/secret.txt', ENC.encode('SECRET\n'))
  const resources: Record<string, RAMResource> = { '/a': a, '/b': b }
  let root: RAMResource | null = null
  if (options.rootMount === true) {
    root = new RAMResource()
    root.store.files.set('/root.txt', ENC.encode('top\n'))
    resources['/'] = root
  }
  const registry = new OpsRegistry()
  for (const r of Object.values(resources)) registry.registerResource(r)
  const ws = new Workspace(resources, {
    mode: MountMode.WRITE,
    modeOverrides: options.modes ?? {},
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

    const ok = await ws.execute('cat /a/x.txt', { sessionId: 'agent' })
    expect(ok.exitCode).toBe(0)
    expect(stdoutStr(ok)).toContain('hi')

    const denied = await ws.execute('rm /a/x.txt', { sessionId: 'agent' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('read-only mount at /a/')
    expect(a.store.files.has('/x.txt')).toBe(true)
  })

  it('read grant blocks redirect writes', async () => {
    const { ws, a } = await makeGrantsWorkspace()
    ws.createSession('agent', { mounts: { '/a': MountMode.READ } })

    const denied = await ws.execute('echo leaked > /a/y.txt', { sessionId: 'agent' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('read-only')
    expect(a.store.files.has('/y.txt')).toBe(false)
  })

  it('write grant allows writes', async () => {
    const { ws, a } = await makeGrantsWorkspace()
    ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })

    const io = await ws.execute('echo new > /a/y.txt', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(a.store.files.has('/y.txt')).toBe(true)
  })

  it('grant cannot widen a READ mount', async () => {
    const { ws } = await makeGrantsWorkspace({ modes: { '/a': MountMode.READ } })
    ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })

    const denied = await ws.execute('echo up > /a/y.txt', { sessionId: 'agent' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('read-only')
  })

  it('list form inherits the mount mode', async () => {
    const { ws, a } = await makeGrantsWorkspace()
    ws.createSession('agent', { mounts: ['/a'] })

    const io = await ws.execute('echo ok > /a/y.txt', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(a.store.files.has('/y.txt')).toBe(true)
  })

  it('ungranted mounts stay invisible', async () => {
    const { ws } = await makeGrantsWorkspace()
    ws.createSession('agent', { mounts: { '/a': MountMode.READ } })

    const denied = await ws.execute('cat /b/secret.txt', { sessionId: 'agent' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('not allowed')
    expect(stdoutStr(denied)).not.toContain('SECRET')
  })

  it('a user-defined root mount is governed by grants', async () => {
    const { ws } = await makeGrantsWorkspace({ rootMount: true })
    ws.createSession('no_root', { mounts: { '/a': MountMode.WRITE } })
    ws.createSession('root_ro', { mounts: { '/a': MountMode.WRITE, '/': MountMode.READ } })

    const denied = await ws.execute('cat /root.txt', { sessionId: 'no_root' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('not allowed')

    const readOk = await ws.execute('cat /root.txt', { sessionId: 'root_ro' })
    expect(readOk.exitCode).toBe(0)
    expect(stdoutStr(readOk)).toContain('top')

    const writeDenied = await ws.execute('echo x > /root.txt', { sessionId: 'root_ro' })
    expect(writeDenied.exitCode).not.toBe(0)
    expect(stderrStr(writeDenied)).toContain('read-only')
  })

  it('the implicit scratch root keeps pathless commands working', async () => {
    const { ws } = await makeGrantsWorkspace()
    ws.createSession('agent', { mounts: { '/a': MountMode.READ } })

    const io = await ws.execute('echo hi | wc -l', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io).trim()).toBe('1')
  })

  it('rejects invalid roles', async () => {
    const { ws } = await makeGrantsWorkspace()
    expect(() => ws.createSession('agent', { mounts: { '/a': 'admin' as MountMode } })).toThrow(
      'invalid mount role',
    )
  })

  it('accepts filesystem alias roles, rejects bit-style forms', async () => {
    const { ws } = await makeGrantsWorkspace()
    const sess = ws.createSession('agent', { mounts: { '/a': 'rw' } })
    expect(sess.mountGrants?.get('/a')).toBe(MountMode.WRITE)
    expect(() => ws.createSession('bits', { mounts: { '/a': 'w' } })).toThrow('invalid mount role')
  })
})
