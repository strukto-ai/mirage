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
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

async function twoMountWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  const r2 = new RAMResource()
  const ram = new RAMResource()
  ops.registerResource(root)
  ops.registerResource(r2)
  ops.registerResource(ram)
  return new Workspace(
    { '/': root, '/r2': r2, '/ram': ram },
    { mode: MountMode.WRITE, ops, shellParser: parser },
  )
}

async function nestedWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  const data = new RAMResource()
  const inner = new RAMResource()
  ops.registerResource(root)
  ops.registerResource(data)
  ops.registerResource(inner)
  return new Workspace(
    { '/': root, '/data': data, '/data/inner': inner },
    { mode: MountMode.WRITE, ops, shellParser: parser },
  )
}

async function singleMountWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  const r2 = new RAMResource()
  ops.registerResource(root)
  ops.registerResource(r2)
  return new Workspace(
    { '/': root, '/r2': r2 },
    { mode: MountMode.WRITE, ops, shellParser: parser },
  )
}

// ════════════════════════════════════════════════════════════════════
// Write rule
// ════════════════════════════════════════════════════════════════════

describe('mount-root protection — rm', () => {
  it('rm refuses a mount root', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('rm /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Device or resource busy/)
    expect(r.stderrText).toMatch(/\/r2/)
    await ws.close()
  })

  it('rm -rf refuses a mount root', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('rm -rf /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Device or resource busy/)
    await ws.close()
  })

  it('rm -rf refuses a mount root with a trailing slash', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('rm -rf /r2/')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Device or resource busy/)
    await ws.close()
  })

  it('rm inside a mount still works', async () => {
    const ws = await twoMountWs()
    await ws.execute('touch /r2/file')
    const r = await ws.execute('rm /r2/file')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })

  it('rm -rf inside a mount still works', async () => {
    const ws = await twoMountWs()
    await ws.execute('mkdir /r2/sub')
    await ws.execute('touch /r2/sub/x')
    const r = await ws.execute('rm -rf /r2/sub')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })

  it('rm refusal preserves mount contents', async () => {
    const ws = await twoMountWs()
    await ws.execute('touch /r2/keep')
    const r = await ws.execute('rm -rf /r2')
    expect(r.exitCode).toBe(1)
    const ls = await ws.execute('ls /r2')
    expect(ls.stdoutText).toMatch(/keep/)
    await ws.close()
  })
})

describe('mount-root protection — mv', () => {
  it('mv refuses a mount root as source', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('mv /r2 /elsewhere')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Device or resource busy/)
    await ws.close()
  })
})

describe('mount-root protection — mkdir', () => {
  it('mkdir refuses an existing mount root', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('mkdir /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/File exists/)
    await ws.close()
  })

  it('mkdir -p on a mount root is idempotent (no error)', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('mkdir -p /r2')
    expect(r.exitCode).toBe(0)
    expect(r.stderrText).toBe('')
    await ws.close()
  })

  it('mkdir inside a mount is allowed', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('mkdir /r2/newdir')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })
})

describe('mount-root protection — touch', () => {
  it('touch refuses a mount root', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('touch /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Is a directory/)
    await ws.close()
  })

  it('touch inside a mount is allowed', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('touch /r2/newfile')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })
})

describe('mount-root protection — ln', () => {
  it('ln refuses a mount root as link name', async () => {
    const ws = await twoMountWs()
    await ws.execute('touch /ram/source')
    const r = await ws.execute('ln /ram/source /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/File exists/)
    await ws.close()
  })

  it('ln -s refuses a mount root as link name', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('ln -s /ram/source /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/File exists/)
    await ws.close()
  })

  it('ln within a single mount is not blocked by the mount-root guard', async () => {
    const ws = await twoMountWs()
    await ws.execute('touch /r2/source')
    const r = await ws.execute('ln -s /r2/source /r2/link')
    // The guard's "File exists" must NOT fire — link target is not a mount root.
    expect(r.stderrText).not.toMatch(/File exists/)
    await ws.close()
  })
})

describe('mount-root protection — nested mounts', () => {
  it('rm refuses a nested mount root', async () => {
    const ws = await nestedWs()
    const r = await ws.execute('rm -rf /data/inner')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Device or resource busy/)
    await ws.close()
  })

  it('rm inside the nested mount still works', async () => {
    const ws = await nestedWs()
    await ws.execute('touch /data/inner/x')
    const r = await ws.execute('rm /data/inner/x')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })

  it('rm inside the outer mount still works', async () => {
    const ws = await nestedWs()
    await ws.execute('touch /data/outer-file')
    const r = await ws.execute('rm /data/outer-file')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })
})

// ════════════════════════════════════════════════════════════════════
// Read fan-out
// ════════════════════════════════════════════════════════════════════

describe('traversal fan-out — find', () => {
  it('find / -maxdepth 1 -mindepth 1 -type d lists mount prefixes', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('find / -maxdepth 1 -mindepth 1 -type d')
    expect(r.exitCode).toBe(0)
    expect(r.stdoutText).toMatch(/\/r2/)
    expect(r.stdoutText).toMatch(/\/ram/)
    await ws.close()
  })

  it('find / descends into each mount and surfaces files from all', async () => {
    const ws = await twoMountWs()
    await ws.execute('touch /r2/a')
    await ws.execute('touch /ram/b')
    const r = await ws.execute('find /')
    expect(r.stdoutText).toMatch(/\/r2\/a/)
    expect(r.stdoutText).toMatch(/\/ram\/b/)
    await ws.close()
  })

  it('find inside one mount does not leak entries from siblings', async () => {
    const ws = await twoMountWs()
    await ws.execute('touch /r2/only-a')
    await ws.execute('touch /ram/only-b')
    const r = await ws.execute('find /r2')
    expect(r.stdoutText).toMatch(/\/r2\/only-a/)
    expect(r.stdoutText).not.toMatch(/\/ram/)
    await ws.close()
  })

  it('find on a single-mount workspace does not fan out', async () => {
    const ws = await singleMountWs()
    await ws.execute('touch /r2/file')
    const r = await ws.execute('find /r2')
    expect(r.exitCode).toBe(0)
    expect(r.stdoutText).toMatch(/\/r2\/file/)
    await ws.close()
  })

  it('find / with nested mounts surfaces both layers', async () => {
    const ws = await nestedWs()
    await ws.execute('touch /data/outer-file')
    await ws.execute('touch /data/inner/inner-file')
    const r = await ws.execute('find /')
    expect(r.stdoutText).toMatch(/\/data\/outer-file/)
    expect(r.stdoutText).toMatch(/\/data\/inner\/inner-file/)
    await ws.close()
  })

  it('find -maxdepth bounds skip too-deep nested mounts', async () => {
    const ws = await nestedWs()
    await ws.execute('touch /data/inner/x')
    await ws.execute('touch /data/outer-file')
    const r = await ws.execute('find / -maxdepth 1')
    // /data is at depth 1 → included
    expect(r.stdoutText).toMatch(/\/data/)
    // /data/inner/x is at depth 3 → excluded
    expect(r.stdoutText).not.toMatch(/\/data\/inner\/x/)
    await ws.close()
  })
})

describe('traversal fan-out — grep -r', () => {
  it('grep -r at root searches across mounts', async () => {
    const ws = await twoMountWs()
    await ws.execute("sh -c 'echo needle > /r2/a.txt'")
    await ws.execute("sh -c 'echo other > /ram/b.txt'")
    await ws.execute("sh -c 'echo needle > /ram/c.txt'")
    const r = await ws.execute('grep -r needle /')
    expect(r.stdoutText).toMatch(/\/r2\/a\.txt/)
    expect(r.stdoutText).toMatch(/\/ram\/c\.txt/)
    expect(r.stdoutText).not.toMatch(/\/ram\/b\.txt/)
    await ws.close()
  })
})

describe('traversal fan-out — du', () => {
  it('du / fans out across mounts', async () => {
    const ws = await twoMountWs()
    await ws.execute("sh -c 'echo content > /r2/file'")
    await ws.execute("sh -c 'echo other > /ram/file'")
    const r = await ws.execute('du /')
    expect(r.stdoutText).toMatch(/\/r2/)
    expect(r.stdoutText).toMatch(/\/ram/)
    await ws.close()
  })
})

// ════════════════════════════════════════════════════════════════════
// ls / unchanged
// ════════════════════════════════════════════════════════════════════

describe('ls / unchanged after mount-root protection', () => {
  it('ls / still lists mount prefixes', async () => {
    const ws = await twoMountWs()
    const r = await ws.execute('ls /')
    expect(r.stdoutText.split('\n')).toContain('r2')
    expect(r.stdoutText.split('\n')).toContain('ram')
    await ws.close()
  })
})

// ════════════════════════════════════════════════════════════════════
// rm safety flags: accepted no-ops given mirage's structural protection
// (non-interactive; mount roots unremovable; recursion never crosses a
// mount boundary).
// ════════════════════════════════════════════════════════════════════

describe('rm safety flags', () => {
  it('-I and -i are accepted no-ops; removal still proceeds', async () => {
    const ws = await twoMountWs()
    await ws.execute('touch /r2/a /r2/b')
    expect((await ws.execute('rm -I /r2/a')).exitCode).toBe(0)
    expect((await ws.execute('rm -i /r2/b')).exitCode).toBe(0)
    expect((await ws.execute('ls /r2')).stdoutText.trim()).toBe('')
    await ws.close()
  })

  it('--one-file-system is accepted and removes within the mount', async () => {
    const ws = await twoMountWs()
    await ws.execute('mkdir -p /r2/d && touch /r2/d/x')
    const r = await ws.execute('rm --one-file-system -rf /r2/d')
    expect(r.exitCode).toBe(0)
    expect((await ws.execute('ls /r2')).stdoutText.trim()).toBe('')
    await ws.close()
  })

  it('--preserve-root and --no-preserve-root cannot remove a mount root', async () => {
    // mirage protection is structural: --no-preserve-root does not disable it.
    const ws = await twoMountWs()
    for (const cmd of ['rm --preserve-root -rf /', 'rm --no-preserve-root -rf /r2']) {
      const r = await ws.execute(cmd)
      expect(r.exitCode).toBe(1)
      expect(r.stderrText).toContain('Device or resource busy')
    }
    await ws.close()
  })

  it('rm -I no longer errors as an invalid option', async () => {
    const ws = await twoMountWs()
    await ws.execute('touch /r2/a')
    const r = await ws.execute('rm -rfI /r2/a')
    expect(r.exitCode).toBe(0)
    expect(r.stderrText).not.toContain('invalid option')
    await ws.close()
  })
})
