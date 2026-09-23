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
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

// Regression coverage for GitHub issue #43:
// `grep -rEn pattern .` and `grep -rEn pattern /` returned exitCode=1 even
// when matches were present in stdout, because the fan-out across descendant
// mounts (e.g. /.bash_history, /dev) wrote the aggregated 0 onto mergedIo but
// left streamSource pointing at a failing sub-IO, whose lazy value clobbered
// the 0 back to 1. The explicit write now severs the link, so the aggregated
// status wins.

const ENC = new TextEncoder()

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMVFS()
  r.store.dirs.add('/')
  r.store.dirs.add('/src')
  r.store.files.set('/src/a.js', ENC.encode('legacyFetch("/api");\n'))
  const registry = new OpsRegistry()
  registry.registerVfs(r)
  return new Workspace({ '/': r }, { mode: MountMode.WRITE, ops: registry, shellParser: parser })
}

describe('grep -r recursive exit code (issue #43)', () => {
  it('exit 0 when search root is a single-mount subdir with matches', async () => {
    const ws = await makeWs()
    const io = await ws.shell('grep -rEn "legacyFetch" /src')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('legacyFetch')
    await ws.close()
  })

  it('exit 0 when search root is / and descendant mounts exist (fan-out)', async () => {
    const ws = await makeWs()
    const io = await ws.shell('grep -rEn "legacyFetch" /')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('legacyFetch')
    await ws.close()
  })

  it('exit 0 when search root is . and descendant mounts exist (fan-out)', async () => {
    const ws = await makeWs()
    const io = await ws.shell('grep -rEn "legacyFetch" .')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('legacyFetch')
    await ws.close()
  })

  it('exit 1 when no match exists anywhere under /', async () => {
    const ws = await makeWs()
    const io = await ws.shell('grep -rEn "doesNotExistAnywhere" /')
    expect(io.exitCode).toBe(1)
    await ws.close()
  })

  it('if-then takes the true branch when grep -r / finds a match', async () => {
    const ws = await makeWs()
    const io = await ws.shell('if grep -rEn "legacyFetch" /; then echo FOUND; fi')
    expect(stdoutStr(io)).toContain('FOUND')
    await ws.close()
  })

  it('&& runs the right arm when grep -r / finds a match', async () => {
    const ws = await makeWs()
    const io = await ws.shell('grep -rEn "legacyFetch" / && echo OK')
    expect(stdoutStr(io)).toContain('OK')
    await ws.close()
  })

  it('|| does not run the right arm when grep -r / finds a match', async () => {
    const ws = await makeWs()
    const io = await ws.shell('grep -rEn "legacyFetch" / || echo SHOULD_NOT_PRINT')
    expect(stdoutStr(io)).not.toContain('SHOULD_NOT_PRINT')
    await ws.close()
  })
})

it('keeps binary-only matches through nested mount fan-out', async () => {
  const outer = new RAMVFS()
  const inner = new RAMVFS()
  outer.store.dirs.add('/')
  outer.store.dirs.add('/work')
  inner.store.files.set('/paper.pdf', ENC.encode('needle\0tail\n'))
  const registry = new OpsRegistry()
  registry.registerVfs(outer)
  registry.registerVfs(inner)
  const ws = new Workspace(
    { '/': outer, '/work/remote': inner },
    { mode: MountMode.WRITE, ops: registry, shellParser: await getTestParser() },
  )
  try {
    const normal = await ws.shell('grep -r needle /work')
    expect(normal.exitCode).toBe(0)
    expect(stdoutStr(normal)).toBe('')
    expect(new TextDecoder().decode(normal.stderr)).toContain(
      '/work/remote/paper.pdf: binary file matches',
    )
    const skipped = await ws.shell('grep -Ir needle /work')
    expect(skipped.exitCode).toBe(1)
    expect(stdoutStr(skipped)).toBe('')
  } finally {
    await ws.close()
  }
})
