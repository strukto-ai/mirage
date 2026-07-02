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
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode } from '../types.ts'
import { applyStateDict, toStateDict } from './snapshot/state.ts'
import { Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser
let tempDir: string

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
  tempDir = mkdtempSync(join(tmpdir(), 'mirage-symlinks-'))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function buildWorkspace(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  ops.registerResource(ram)
  return new Workspace({ '/data': ram }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

const dec = (b: Uint8Array | null): string => (b === null ? '' : new TextDecoder().decode(b))

describe('symlinks (namespace-backed)', () => {
  it('ln -s then readlink returns the target verbatim', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    const r1 = await ws.execute('ln -s /data/a.txt /data/link.txt')
    expect(r1.exitCode).toBe(0)
    const r2 = await ws.execute('readlink /data/link.txt')
    expect(dec(r2.stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  it('keeps a relative target verbatim', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s a.txt /data/link.txt')
    const r = await ws.execute('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('a.txt\n')
    await ws.close()
  })

  it('ln -s -f overwrites an existing link', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo a > /data/a.txt')
    await ws.execute('echo b > /data/b.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    await ws.execute('ln -s -f /data/b.txt /data/link.txt')
    const r = await ws.execute('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('/data/b.txt\n')
    await ws.close()
  })

  it('ln -s without -f refuses an existing link', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo a > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    const r = await ws.execute('ln -s /data/a.txt /data/link.txt')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('File exists')
    await ws.close()
  })

  it('cd follows a directory symlink', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/real')
    await ws.execute('ln -s /data/real /data/slink')
    const r = await ws.execute('cd /data/slink && pwd')
    expect(dec(r.stdout)).toBe('/data/real\n')
    await ws.close()
  })

  it('cd through a symlink loop is ELOOP', async () => {
    const ws = buildWorkspace()
    await ws.execute('ln -s /data/b /data/a')
    await ws.execute('ln -s /data/a /data/b')
    const r = await ws.execute('cd /data/a')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('Too many levels of symbolic links')
    await ws.close()
  })

  it('symlinks survive a snapshot round-trip', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    const state = await toStateDict(ws)
    const ws2 = buildWorkspace()
    await applyStateDict(ws2, state)
    const r = await ws2.execute('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    await ws.close()
    await ws2.close()
  })

  it('cat follows a link', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    const r = await ws.execute('cat /data/link.txt')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('read follows a mid-path directory link', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/real && echo hi > /data/real/f.txt')
    await ws.execute('ln -s /data/real /data/dirlink')
    const r = await ws.execute('cat /data/dirlink/f.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('read follows a relative target', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/sub && echo hi > /data/sub/a.txt')
    await ws.execute('ln -s a.txt /data/sub/link.txt')
    const r = await ws.execute('cat /data/sub/link.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('write through a link updates the target', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo old > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    await ws.execute('echo new > /data/link.txt')
    const r = await ws.execute('cat /data/a.txt')
    expect(dec(r.stdout)).toBe('new\n')
    await ws.close()
  })

  it('cat of a dangling link errors with the typed name', async () => {
    const ws = buildWorkspace()
    await ws.execute('ln -s /data/missing /data/dangle')
    const r = await ws.execute('cat /data/dangle')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('/data/dangle')
    await ws.close()
  })

  it('cat of a link loop is ELOOP with the operand named', async () => {
    const ws = buildWorkspace()
    await ws.execute('ln -s /data/b /data/a')
    await ws.execute('ln -s /data/a /data/b')
    const r = await ws.execute('cat /data/a')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('cat: /data/a: Too many levels of symbolic links')
    await ws.close()
  })

  it('ls lists links, -F marks them, -l shows the arrow', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('ls /data')
    expect(dec(r.stdout)).toContain('link.txt')
    r = await ws.execute('ls -F /data')
    expect(dec(r.stdout)).toContain('link.txt@')
    r = await ws.execute('ls -l /data')
    expect(dec(r.stdout)).toContain('link.txt -> /data/a.txt')
    await ws.close()
  })

  it('ls through a directory link lists the target', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/real && echo hi > /data/real/f.txt')
    await ws.execute('ln -s /data/real /data/dirlink')
    const r = await ws.execute('ls /data/dirlink')
    expect(dec(r.stdout)).toBe('f.txt\n')
    await ws.close()
  })

  it('rm removes the link, not the target', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('rm /data/link.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('readlink /data/link.txt')
    expect(r.exitCode).toBe(1)
    r = await ws.execute('cat /data/a.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('rm removes a dangling link', async () => {
    const ws = buildWorkspace()
    await ws.execute('ln -s /data/missing /data/dangle')
    const r = await ws.execute('rm /data/dangle')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })

  it('rm handles mixed link and file operands', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt && echo x > /data/b.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    const r = await ws.execute('rm /data/link.txt /data/b.txt')
    expect(r.exitCode).toBe(0)
    const ls = await ws.execute('ls /data')
    expect(dec(ls.stdout)).toBe('a.txt\n')
    await ws.close()
  })

  it('rm of the target leaves the link dangling', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    await ws.execute('rm /data/a.txt')
    let r = await ws.execute('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    r = await ws.execute('cat /data/link.txt')
    expect(r.exitCode).toBe(1)
    await ws.close()
  })

  it('rm -r purges links under the removed dir', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/sub && echo hi > /data/sub/f.txt')
    await ws.execute('ln -s /data/sub/f.txt /data/sub/inner')
    let r = await ws.execute('rm -r /data/sub')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('readlink /data/sub/inner')
    expect(r.exitCode).toBe(1)
    await ws.close()
  })

  it('mv renames the link entry', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('mv /data/link.txt /data/renamed.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('readlink /data/renamed.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    r = await ws.execute('readlink /data/link.txt')
    expect(r.exitCode).toBe(1)
    await ws.close()
  })

  it('mv moves a link into an existing directory', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/dir && echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('mv /data/link.txt /data/dir')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('readlink /data/dir/link.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  it('mv of a file onto a link replaces the entry', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo a > /data/a.txt && echo b > /data/b.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('mv /data/b.txt /data/link.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('readlink /data/link.txt')
    expect(r.exitCode).toBe(1)
    r = await ws.execute('cat /data/link.txt')
    expect(dec(r.stdout)).toBe('b\n')
    r = await ws.execute('cat /data/a.txt')
    expect(dec(r.stdout)).toBe('a\n')
    await ws.close()
  })

  it('cp follows the source link', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('cp /data/link.txt /data/copy.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('cat /data/copy.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('grep follows a link', async () => {
    const ws = buildWorkspace()
    await ws.execute("printf 'alpha\\nbeta\\n' > /data/a.txt")
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    const r = await ws.execute('grep beta /data/link.txt')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toContain('beta')
    await ws.close()
  })
})
