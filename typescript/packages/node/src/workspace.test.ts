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

import { chmodSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { DiskResource } from './resource/disk/disk.ts'
import { tmpRoot } from './test-utils.ts'
import { Workspace } from './workspace.ts'

describe('@struktoai/mirage-node Workspace', () => {
  it('lazy-loads the shell parser via readFileSync(require.resolve(...)) on first execute()', async () => {
    const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
    const res = await ws.execute('echo hi')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('reuses the cached parser across multiple execute() calls', async () => {
    const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
    const r1 = await ws.execute('echo one')
    const r2 = await ws.execute('echo two')
    expect(new TextDecoder().decode(r1.stdout)).toBe('one\n')
    expect(new TextDecoder().decode(r2.stdout)).toBe('two\n')
    await ws.close()
  })

  it('respects an explicitly provided shellParserFactory', async () => {
    let calls = 0
    const ws = new Workspace(
      { '/data': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParserFactory: async () => {
          calls += 1
          const { createShellParser } = await import('@struktoai/mirage-core')
          const { readFileSync } = await import('node:fs')
          const { createRequire } = await import('node:module')
          const requireCjs = createRequire(import.meta.url)
          return createShellParser({
            engineWasm: readFileSync(requireCjs.resolve('web-tree-sitter/web-tree-sitter.wasm')),
            grammarWasm: readFileSync(requireCjs.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
          })
        },
      },
    )
    await ws.execute('echo a')
    await ws.execute('echo b')
    expect(calls).toBe(1)
    await ws.close()
  })

  it.each([['-maxdepth abc'], ['-mindepth xx'], ["-size ''"], ['-size abc'], ['-mtime abc']])(
    'find %s exits 1 with a clean stderr instead of crashing',
    async (expr) => {
      const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
      const res = await ws.execute(`find / ${expr}`)
      expect(res.exitCode).toBe(1)
      const stderr = new TextDecoder().decode(res.stderr)
      expect(stderr.startsWith('find: invalid argument ')).toBe(true)
      expect(stderr.endsWith('\n')).toBe(true)
      await ws.close()
    },
  )

  it.each([
    ["echo a '' b", 'a  b\n'],
    ['echo a "" b', 'a  b\n'],
  ])('keeps a quoted empty string as a real argument: %s', async (cmd, expected) => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const res = await ws.execute(cmd)
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe(expected)
    await ws.close()
  })
})

describe('@struktoai/mirage-node Workspace disk metadata', () => {
  function makeDiskWs(): { ws: Workspace; root: string; cleanup: () => void } {
    const { root, cleanup } = tmpRoot('mirage-node-meta-')
    writeFileSync(join(root, 'f.txt'), 'hello')
    const ws = new Workspace(
      { '/data': [new DiskResource({ root }), MountMode.WRITE] },
      { mode: MountMode.WRITE },
    )
    return { ws, root, cleanup }
  }

  it('chmod 000 shows zero in ls -l but keeps owner access', async () => {
    const { ws, root, cleanup } = makeDiskWs()
    const c = await ws.execute('chmod 000 /data/f.txt')
    expect(c.exitCode).toBe(0)
    const ls = await ws.execute('ls -l /data')
    expect(ls.stdoutText).toContain('----------')
    expect(statSync(join(root, 'f.txt')).mode & 0o777).toBe(0o600)
    const cat = await ws.execute('cat /data/f.txt')
    expect(cat.exitCode).toBe(0)
    expect(cat.stdoutText).toBe('hello')
    await ws.close()
    cleanup()
  })

  it('relaxing chmod drops the stale residual overlay', async () => {
    const { ws, cleanup } = makeDiskWs()
    await ws.execute('chmod 000 /data/f.txt')
    await ws.execute('chmod 644 /data/f.txt')
    const st = (await ws.dispatch('stat', '/data/f.txt')) as { mode: number }
    expect(st.mode).toBe(0o644)
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()
    await ws.close()
    cleanup()
  })

  it('shows an external chmod in ls -l', async () => {
    const { ws, root, cleanup } = makeDiskWs()
    chmodSync(join(root, 'f.txt'), 0o640)
    const ls = await ws.execute('ls -l /data')
    expect(ls.stdoutText).toContain('-rw-r-----')
    await ws.close()
    cleanup()
  })

  it('overlays chown and renders owner/group in ls -l', async () => {
    const { ws, cleanup } = makeDiskWs()
    const c = await ws.execute('chown 500:dev /data/f.txt')
    expect(c.exitCode).toBe(0)
    const ls = await ws.execute('ls -l /data')
    expect(ls.stdoutText).toContain(' 500 dev ')
    await ws.close()
    cleanup()
  })
})
