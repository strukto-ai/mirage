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
import { OpsRegistry } from '../../../../ops/registry.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { MountMode } from '../../../../types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../../../fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace.ts'

// Direct port of tests/workspace/executor/builtins/test_exec_path.py: a
// slash-carrying head word runs the file, bash's loader rule.

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const root = new RAMVFS()
  const work = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(root)
  registry.registerVfs(work)
  return new Workspace(
    { '/': root, '/work/': work },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

describe('direct path execution', () => {
  it('runs a script written to a mount', async () => {
    const ws = await makeWs()
    await ws.shell("printf 'echo ran\\n' > /work/run.sh")
    const io = await ws.shell('/work/run.sh')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('ran\n')
  })

  it('resolves a relative path against the cwd', async () => {
    const ws = await makeWs()
    await ws.shell("printf 'echo rel\\n' > /work/run.sh")
    const io = await ws.shell('cd /work && ./run.sh')
    expect(stdoutStr(io)).toBe('rel\n')
  })

  it('honors shebang interpreter options', async () => {
    const ws = await makeWs()
    await ws.shell("printf '#!/bin/bash -x\\necho traced\\n' > /work/t.sh")
    const io = await ws.shell('/work/t.sh')
    expect(stdoutStr(io)).toBe('traced\n')
    expect(stderrStr(io)).toBe('+ echo traced\n')
  })

  it('a missing file is 127', async () => {
    const ws = await makeWs()
    const io = await ws.shell('/work/nope.sh')
    expect(io.exitCode).toBe(127)
    expect(stderrStr(io)).toBe('/work/nope.sh: No such file or directory\n')
  })

  it('a directory is 126', async () => {
    const ws = await makeWs()
    await ws.shell('mkdir -p /work/adir')
    const io = await ws.shell('/work/adir')
    expect(io.exitCode).toBe(126)
    expect(stderrStr(io)).toBe('/work/adir: Is a directory\n')
  })

  it('an unknown interpreter reports command not found', async () => {
    const ws = await makeWs()
    await ws.shell("printf '#!/usr/bin/env ruby\\nputs 1\\n' > /work/r.rb")
    const io = await ws.shell('/work/r.rb')
    expect(io.exitCode).toBe(127)
    expect(stderrStr(io)).toBe('ruby: command not found\n')
  })

  it('child shell state does not leak', async () => {
    const ws = await makeWs()
    await ws.shell("printf 'cd /work\\nexit 3\\n' > /child.sh")
    const io = await ws.shell('/child.sh; echo "$?:$(pwd)"')
    expect(stdoutStr(io)).toBe('3:/\n')
  })

  it("consumes env's -S and applies the split interpreter options", async () => {
    // GNU env's -S is how a shebang passes interpreter options; the
    // option must never read as the interpreter itself.
    const ws = await makeWs()
    await ws.shell("printf '#!/usr/bin/env -S bash -x\\necho ok\\n' > /work/s.sh")
    const io = await ws.shell('/work/s.sh')
    expect(stdoutStr(io)).toBe('ok\n')
    expect(stderrStr(io)).toBe('+ echo ok\n')
  })

  it('reads the attached and long -S spellings too', async () => {
    const ws = await makeWs()
    await ws.shell("printf '#!/usr/bin/env -Sbash -x\\necho a\\n' > /work/a.sh")
    await ws.shell("printf '#!/usr/bin/env --split-string=bash -x\\necho b\\n' > /work/b.sh")
    const a = await ws.shell('/work/a.sh')
    expect(stdoutStr(a)).toBe('a\n')
    expect(stderrStr(a)).toBe('+ echo a\n')
    const b = await ws.shell('/work/b.sh')
    expect(stdoutStr(b)).toBe('b\n')
    expect(stderrStr(b)).toBe('+ echo b\n')
  })

  it('a path guard sees the executed file', async () => {
    // The executed file lives in argv[0], not the operands, so the
    // admission context must carry it or a path-pattern guard never
    // fires on direct execution. Seeding runs through an unguarded
    // workspace sharing the VFS, since a command-less guard also
    // seals the op layer.
    const parser = await getTestParser()
    const prod = new RAMVFS()
    const seedOps = new OpsRegistry()
    seedOps.registerVfs(prod)
    const seed = new Workspace(
      { '/data/': prod },
      { mode: MountMode.WRITE, ops: seedOps, shellParser: parser },
    )
    await seed.shell('mkdir -p /data/prod')
    await seed.shell("printf 'echo leaked\\n' > /data/prod/run.sh")
    await seed.shell("printf 'echo fine\\n' > /data/ok.sh")
    const root = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(root)
    ops.registerVfs(prod)
    const ws = new Workspace(
      { '/': root, '/data/': prod },
      {
        mode: MountMode.WRITE,
        ops,
        shellParser: parser,
        profiles: {
          default: {
            commands: {
              deny: [{ reason: 'production scripts are sealed', paths: ['/data/prod/*'] }],
            },
          },
        },
      },
    )
    const refused = await ws.shell('/data/prod/run.sh')
    expect(refused.exitCode).toBe(1)
    expect(stderrStr(refused)).toContain('production scripts are sealed')
    expect(stdoutStr(refused)).toBe('')
    const relative = await ws.shell('cd /data/prod && ./run.sh')
    expect(relative.exitCode).toBe(1)
    expect(stderrStr(relative)).toContain('production scripts are sealed')
    const outside = await ws.shell('/data/ok.sh')
    expect(outside.exitCode).toBe(0)
    expect(stdoutStr(outside)).toBe('fine\n')
  })
})
