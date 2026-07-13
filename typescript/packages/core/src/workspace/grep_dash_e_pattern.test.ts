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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

// POSIX: `grep -e pat file` must behave like `grep pat file`. The pattern
// positional used to consume the file path even when -e supplied the pattern,
// leaving paths() empty and grep exiting 1 with no output.

const ENC = new TextEncoder()

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  r.store.dirs.add('/')
  r.store.dirs.add('/data')
  r.store.files.set('/data/a.txt', ENC.encode('orange line\nplain line\nlast line\n'))
  r.store.files.set('/data/pats.txt', ENC.encode('orange\nlast\n'))
  r.store.files.set('/data/p1.txt', ENC.encode('orange\n'))
  r.store.files.set('/data/p2.txt', ENC.encode('last\n'))
  r.store.files.set('/data/empty.txt', new Uint8Array())
  const registry = new OpsRegistry()
  registry.registerResource(r)
  return new Workspace({ '/': r }, { mode: MountMode.WRITE, ops: registry, shellParser: parser })
}

describe('grep -e pattern flag', () => {
  it('matches like a positional pattern', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -e orange /data/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('orange line\n')
    await ws.close()
  })

  it('positional pattern still works', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep orange /data/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('orange line\n')
    await ws.close()
  })

  it('repeated -e matches lines hitting any pattern', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -e orange -e plain /data/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('orange line\nplain line\n')
    await ws.close()
  })

  it('-f reads patterns from a workspace file', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -f /data/pats.txt /data/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('orange line\nlast line\n')
    await ws.close()
  })

  it('-e and -f union', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -e plain -f /data/pats.txt /data/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('orange line\nplain line\nlast line\n')
    await ws.close()
  })

  it('repeated -f unions pattern files', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -f /data/p1.txt -f /data/p2.txt /data/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('orange line\nlast line\n')
    await ws.close()
  })

  it('-e with repeated -f unions everything', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -e plain -f /data/p1.txt -f /data/p2.txt /data/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('orange line\nplain line\nlast line\n')
    await ws.close()
  })

  it('empty -f file matches nothing (GNU semantics)', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -f /data/empty.txt /data/a.txt')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
    await ws.close()
  })

  it('-v with empty -f file matches everything', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -v -f /data/empty.txt /data/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('orange line\nplain line\nlast line\n')
    await ws.close()
  })

  it('--color=auto is accepted as a GNU no-op', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep --color=auto orange /data/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('orange line\n')
    const stderr = io.stderr instanceof Uint8Array ? new TextDecoder().decode(io.stderr) : ''
    expect(stderr).toBe('')
    await ws.close()
  })

  it('unknown flags refuse with the GNU error and exit 2', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep --bogus orange /data/a.txt')
    expect(io.exitCode).toBe(2)
    const stderr = io.stderr instanceof Uint8Array ? new TextDecoder().decode(io.stderr) : ''
    expect(stderr).toContain("grep: unrecognized option '--bogus'")
    await ws.close()
  })

  it('rg -f reads patterns from a workspace file', async () => {
    const ws = await makeWs()
    const io = await ws.execute('rg -f /data/pats.txt /data/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('orange line')
    expect(stdoutStr(io)).toContain('last line')
    expect(stdoutStr(io)).not.toContain('plain line')
    await ws.close()
  })

  it('zgrep -f reads plain-text pattern files', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cat /data/a.txt | gzip | tee /data/a.gz > /dev/null')
    expect(io.exitCode).toBe(0)
    const z = await ws.execute('zgrep -f /data/pats.txt /data/a.gz')
    expect(z.exitCode).toBe(0)
    expect(stdoutStr(z)).toBe('orange line\nlast line\n')
    await ws.close()
  })

  it('usage errors are exit 2 with a usage message (GNU parity)', async () => {
    const ws = await makeWs()
    for (const cmd of ['grep', 'rg', 'zgrep']) {
      const io = await ws.execute(cmd)
      expect(io.exitCode).toBe(2)
      const stderr = io.stderr instanceof Uint8Array ? new TextDecoder().decode(io.stderr) : ''
      expect(stderr).toBe(`${cmd}: usage: ${cmd} [flags] pattern [path]\n`)
    }
    await ws.close()
  })

  it('rg -e and repeated rg -e work like grep', async () => {
    const ws = await makeWs()
    const single = await ws.execute('rg -e orange /data/a.txt')
    expect(single.exitCode).toBe(0)
    expect(stdoutStr(single)).toContain('orange line')
    const multi = await ws.execute('rg -e orange -e plain /data/a.txt')
    expect(multi.exitCode).toBe(0)
    expect(stdoutStr(multi)).toContain('orange line')
    expect(stdoutStr(multi)).toContain('plain line')
    expect(stdoutStr(multi)).not.toContain('last line')
    await ws.close()
  })
})
