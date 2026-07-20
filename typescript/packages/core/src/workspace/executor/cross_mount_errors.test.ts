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
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace.ts'

// Direct port of tests/workspace/test_cross_mount_errors.py.
// Exercises error paths for cross-mount head/tail — cross_mount.test.ts
// only covers the happy path with mocked dispatch.

const ENC = new TextEncoder()

async function makeTwoRamWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ram1 = new RAMResource()
  const ram2 = new RAMResource()
  ram1.store.files.set('/file.txt', ENC.encode('line1\nline2\nline3\nline4\nline5\n'))
  ram2.store.files.set('/file.txt', ENC.encode('aaa\nbbb\nccc\n'))

  const registry = new OpsRegistry()
  registry.registerResource(ram1)
  registry.registerResource(ram2)

  return new Workspace(
    { '/a': ram1, '/b': ram2 },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

async function runCmd(
  ws: Workspace,
  cmd: string,
): Promise<{ out: string; err: string; code: number }> {
  const io = await ws.execute(cmd)
  return { out: stdoutStr(io), err: stderrStr(io), code: io.exitCode }
}

describe('cross-mount errors (port of tests/workspace/test_cross_mount_errors.py)', () => {
  it('head -n abc across two mounts → exit 1, "invalid number" with "abc"', async () => {
    const ws = await makeTwoRamWs()
    const r = await runCmd(ws, 'head -n abc /a/file.txt /b/file.txt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('invalid number')
    expect(r.err).toContain('abc')
    await ws.close()
  })

  it('tail -n abc across two mounts → exit 1, "invalid number" with "abc"', async () => {
    const ws = await makeTwoRamWs()
    const r = await runCmd(ws, 'tail -n abc /a/file.txt /b/file.txt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('invalid number')
    expect(r.err).toContain('abc')
    await ws.close()
  })

  it('head -n 2 across two mounts → exit 0, first 2 lines of each', async () => {
    const ws = await makeTwoRamWs()
    const r = await runCmd(ws, 'head -n 2 /a/file.txt /b/file.txt')
    expect(r.code).toBe(0)
    expect(r.out).toContain('line1')
    expect(r.out).toContain('line2')
    expect(r.out).toContain('aaa')
    expect(r.out).toContain('bbb')
    await ws.close()
  })

  it('tail -n 1 across two mounts → exit 0, last line of each', async () => {
    const ws = await makeTwoRamWs()
    const r = await runCmd(ws, 'tail -n 1 /a/file.txt /b/file.txt')
    expect(r.code).toBe(0)
    expect(r.out).toContain('line5')
    expect(r.out).toContain('ccc')
    await ws.close()
  })

  it('head default -n across two mounts → exit 0, includes first lines', async () => {
    const ws = await makeTwoRamWs()
    const r = await runCmd(ws, 'head /a/file.txt /b/file.txt')
    expect(r.code).toBe(0)
    expect(r.out).toContain('line1')
    expect(r.out).toContain('aaa')
    await ws.close()
  })
})

async function makeReadonlySrcWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ro = new RAMResource()
  const rw = new RAMResource()
  ro.store.files.set('/report.csv', ENC.encode('name,age\nalice,30\n'))

  const registry = new OpsRegistry()
  registry.registerResource(ro)
  registry.registerResource(rw)

  return new Workspace(
    { '/mail': [ro, MountMode.READ], '/scratch': [rw, MountMode.EXEC] },
    { ops: registry, shellParser: parser },
  )
}

describe('cross-mount mv with an unremovable source', () => {
  it('prints GNU cannot remove and keeps both copies', async () => {
    // GNU mv on a cross-device move that cannot remove the source: the
    // copy stays in place and the failure is a per-entry GNU line.
    const ws = await makeReadonlySrcWs()
    const r = await runCmd(ws, 'mv /mail/report.csv /scratch/x.csv')
    expect(r.code).toBe(1)
    expect(r.err).toBe("mv: cannot remove '/mail/report.csv': Permission denied\n")
    const kept = await runCmd(ws, 'cat /scratch/x.csv')
    expect([kept.out, kept.code]).toEqual(['name,age\nalice,30\n', 0])
    const src = await runCmd(ws, 'cat /mail/report.csv')
    expect([src.out, src.code]).toEqual(['name,age\nalice,30\n', 0])
    await ws.close()
  })
})

describe('cross-mount relay glob expansion', () => {
  it('mv expands source globs before relaying', async () => {
    // RELAY bypasses the mount command wrappers that expand globs for
    // single-mount runs, so the executor expands relay operands itself.
    const ws = await makeTwoRamWs()
    await runCmd(ws, 'echo g1 | tee /a/g1.txt > /dev/null && echo g2 | tee /a/g2.txt > /dev/null')
    const r = await runCmd(ws, 'mv /a/g*.txt /b/')
    expect([r.err, r.code]).toEqual(['', 0])
    const moved = await runCmd(ws, 'cat /b/g1.txt /b/g2.txt')
    expect([moved.out, moved.code]).toEqual(['g1\ng2\n', 0])
    const gone = await runCmd(ws, 'ls /a/g1.txt')
    expect(gone.code).not.toBe(0)
    await ws.close()
  })

  it('an unmatched glob stays the literal word, like bash', async () => {
    const ws = await makeTwoRamWs()
    const r = await runCmd(ws, 'mv /a/nomatch*.zzz /b/')
    expect(r.code).toBe(1)
    expect(r.err).toBe("mv: cannot stat '/a/nomatch*.zzz': No such file or directory\n")
    await ws.close()
  })
})
