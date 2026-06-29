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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  r.store.dirs.add('/')
  r.store.dirs.add('/sub')
  r.store.files.set('/target.txt', ENC.encode('hello\n'))
  r.store.files.set('/sub/deep.txt', ENC.encode('deep\n'))
  const ops = new OpsRegistry()
  ops.registerResource(r)
  return new Workspace({ '/ram/': r }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

async function makeTree(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  for (const d of ['/', '/a', '/x', '/x/y']) r.store.dirs.add(d)
  r.store.files.set('/x/y/f.txt', ENC.encode('deep\n'))
  const ops = new OpsRegistry()
  ops.registerResource(r)
  return new Workspace({ '/ram/': r }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

describe('symlinks (port of tests/workspace/test_symlinks.py)', () => {
  it('ln -s then readlink', async () => {
    const ws = await makeWs()
    const io = await ws.execute('ln -s /ram/target.txt /ram/link && readlink /ram/link')
    expect(stdoutStr(io).trim()).toBe('/ram/target.txt')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('readlink on non-link exits 1, no output', async () => {
    const ws = await makeWs()
    const io = await ws.execute('readlink /ram/target.txt')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
    await ws.close()
  })

  it('readlink returns verbatim relative target', async () => {
    const ws = await makeWs()
    const io = await ws.execute('ln -s deep.txt /ram/sub/dlink && readlink /ram/sub/dlink')
    expect(stdoutStr(io).trim()).toBe('deep.txt')
    await ws.close()
  })

  it('existing link without -f errors', async () => {
    const ws = await makeWs()
    const io = await ws.execute('ln -s /ram/target.txt /ram/link && ln -s /ram/sub /ram/link')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('File exists')
    await ws.close()
  })

  it('ln -sf overwrites', async () => {
    const ws = await makeWs()
    const io = await ws.execute(
      'ln -s /ram/target.txt /ram/link && ln -sf /ram/sub /ram/link && readlink /ram/link',
    )
    expect(stdoutStr(io).trim()).toBe('/ram/sub')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('missing operand errors', async () => {
    const ws = await makeWs()
    const io = await ws.execute('ln -s /ram/target.txt')
    expect(io.exitCode).not.toBe(0)
    await ws.close()
  })

  it('ln -s in subshell persists', async () => {
    const ws = await makeWs()
    const io = await ws.execute('(ln -s /ram/target.txt /ram/link) && readlink /ram/link')
    expect(stdoutStr(io).trim()).toBe('/ram/target.txt')
    await ws.close()
  })

  it('cd through symlink resolves', async () => {
    const ws = await makeTree()
    const io = await ws.execute('ln -s /ram/x/y /ram/a/b && cd /ram/a/b && pwd')
    expect(stdoutStr(io).trim()).toBe('/ram/x/y')
    await ws.close()
  })

  it('cd relative symlink resolves against link dir', async () => {
    const ws = await makeWs()
    const io = await ws.execute('ln -s sub /ram/rlink && cd /ram/rlink && pwd')
    expect(stdoutStr(io).trim()).toBe('/ram/sub')
    await ws.close()
  })

  it('cd logical (-L default) dotdot after symlink', async () => {
    const ws = await makeTree()
    const io = await ws.execute('ln -s /ram/x/y /ram/a/b && cd /ram && cd a/b/.. && pwd')
    expect(stdoutStr(io).trim()).toBe('/ram/a')
    await ws.close()
  })

  it('cd physical (-P) dotdot after symlink', async () => {
    const ws = await makeTree()
    const io = await ws.execute('ln -s /ram/x/y /ram/a/b && cd /ram && cd -P a/b/.. && pwd')
    expect(stdoutStr(io).trim()).toBe('/ram/x')
    await ws.close()
  })

  it('cd symlink cycle → ELOOP message', async () => {
    const ws = await makeTree()
    const io = await ws.execute(
      'ln -s /ram/loop2 /ram/loop && ln -s /ram/loop /ram/loop2 && cd /ram/loop',
    )
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('Too many levels of symbolic links')
    await ws.close()
  })
})

describe('symlinks snapshot round-trip', () => {
  let tempDir: string

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mirage-symlinks-'))
  })

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('symlink survives snapshot + load', async () => {
    const ws = await makeWs()
    await ws.execute('ln -s /ram/target.txt /ram/link')
    const path = join(tempDir, 'sym.json')
    await ws.snapshot(path)
    const parser = await getTestParser()
    const dst = await Workspace.load(path, {
      mode: MountMode.WRITE,
      ops: new OpsRegistry(),
      shellParser: parser,
    })
    const io = await dst.execute('readlink /ram/link')
    expect(stdoutStr(io).trim()).toBe('/ram/target.txt')
    expect(io.exitCode).toBe(0)
    await ws.close()
    await dst.close()
  })
})
