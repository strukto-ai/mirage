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
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'

function twoMountWs(): Workspace {
  const root = new RAMVFS()
  const r2 = new RAMVFS()
  const ram = new RAMVFS()
  return new Workspace({ '/': root, '/r2': r2, '/ram': ram }, { mode: MountMode.WRITE })
}

function nestedWs(): Workspace {
  const root = new RAMVFS()
  const data = new RAMVFS()
  const inner = new RAMVFS()
  return new Workspace(
    { '/': root, '/data': data, '/data/inner': inner },
    { mode: MountMode.WRITE },
  )
}

function singleMountWs(): Workspace {
  const root = new RAMVFS()
  const r2 = new RAMVFS()
  return new Workspace({ '/': root, '/r2': r2 }, { mode: MountMode.WRITE })
}

// ════════════════════════════════════════════════════════════════════
// Write rule
// ════════════════════════════════════════════════════════════════════

describe('mount-root protection — rm', () => {
  it('rm refuses a mount root', async () => {
    // Without -r a mount root is a directory first, as GNU says of a mount
    // point (coreutils 9.7).
    const ws = twoMountWs()
    const r = await ws.shell('rm /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toBe("rm: cannot remove '/r2': Is a directory\n")
    await ws.close()
  })

  it('rm -rf refuses a mount root', async () => {
    const ws = twoMountWs()
    const r = await ws.shell('rm -rf /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Device or resource busy/)
    await ws.close()
  })

  it('rm -rf refuses a mount root with a trailing slash', async () => {
    const ws = twoMountWs()
    const r = await ws.shell('rm -rf /r2/')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Device or resource busy/)
    await ws.close()
  })

  it('rm inside a mount still works', async () => {
    const ws = twoMountWs()
    await ws.shell('touch /r2/file')
    const r = await ws.shell('rm /r2/file')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })

  it('rm -rf inside a mount still works', async () => {
    const ws = twoMountWs()
    await ws.shell('mkdir /r2/sub')
    await ws.shell('touch /r2/sub/x')
    const r = await ws.shell('rm -rf /r2/sub')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })

  it('rm refusal preserves mount contents', async () => {
    const ws = twoMountWs()
    await ws.shell('touch /r2/keep')
    const r = await ws.shell('rm -rf /r2')
    expect(r.exitCode).toBe(1)
    const ls = await ws.shell('ls /r2')
    expect(ls.stdoutText).toMatch(/keep/)
    await ws.close()
  })
})

describe('mount-root protection — mv', () => {
  it('mv refuses a mount root as source', async () => {
    const ws = twoMountWs()
    const r = await ws.shell('mv /r2 /elsewhere')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Device or resource busy/)
    await ws.close()
  })

  // A mount root after the first source would be copied out and its mount
  // emptied; -t makes the last operand a source too. The rows also pin how
  // the refusal names operands: as typed, except the documented divergences
  // (two operands name DST, -t is resolved) and a lone operand, which has no
  // destination to name ('?').
  it.each([
    ['mv /ram/payload /r2 /ram/dst', "'/r2' to '/ram/dst/r2'"],
    ['mv -t /ram/dst /ram/payload /r2', "'/r2' to '/ram/dst/r2'"],
    ['mv --target-directory=/ram/dst /r2', "'/r2' to '/ram/dst/r2'"],
    ['mv /ram/payload /r2 /ram/dst/', "'/r2' to '/ram/dst/r2'"],
    ['mv /r2 /ram/x > /ram/log', "'/r2' to '/ram/x'"],
    ['cd /ram && mv payload ../r2 dst', "'../r2' to 'dst/r2'"],
    ['cd /ram && mv ../r2 x', "'../r2' to 'x'"],
    ['mv /ram/payload /r2/ /ram/dst', "'/r2/' to '/ram/dst/r2'"],
    ['mv /r2', "'/r2' to '?'"],
    ['mv /r2 /ram/dst', "'/r2' to '/ram/dst'"],
    ['cd /ram && mv -t dst ../r2', "'../r2' to '/ram/dst/r2'"],
  ])('mv refuses a mount root as any source: %s', async (line, named) => {
    const ws = twoMountWs()
    await ws.shell('touch /ram/payload /r2/keep && mkdir /ram/dst')
    const r = await ws.shell(line)
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toBe(`mv: cannot move ${named}: Device or resource busy\n`)
    expect((await ws.shell('ls /r2')).stdoutText).toBe('keep\n')
    await ws.close()
  })

  it('mv of several sources into a mount root is allowed', async () => {
    const ws = twoMountWs()
    await ws.shell('touch /ram/a /ram/b')
    expect((await ws.shell('mv /ram/a /ram/b /r2')).exitCode).toBe(0)
    expect((await ws.shell('ls /r2')).stdoutText).toBe('a\nb\n')
    await ws.close()
  })
})

describe('mount-root protection — mkdir', () => {
  it('mkdir refuses an existing mount root', async () => {
    const ws = twoMountWs()
    const r = await ws.shell('mkdir /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/File exists/)
    await ws.close()
  })

  it('mkdir -p on a mount root is idempotent (no error)', async () => {
    const ws = twoMountWs()
    const r = await ws.shell('mkdir -p /r2')
    expect(r.exitCode).toBe(0)
    expect(r.stderrText).toBe('')
    await ws.close()
  })

  it('mkdir inside a mount is allowed', async () => {
    const ws = twoMountWs()
    const r = await ws.shell('mkdir /r2/newdir')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })
})

describe('mount-root protection — touch', () => {
  it('touch refuses a mount root', async () => {
    const ws = twoMountWs()
    const r = await ws.shell('touch /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Is a directory/)
    await ws.close()
  })

  it('touch inside a mount is allowed', async () => {
    const ws = twoMountWs()
    const r = await ws.shell('touch /r2/newfile')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })
})

describe('mount-root protection — ln', () => {
  it('ln refuses a mount root as link name', async () => {
    const ws = twoMountWs()
    await ws.shell('touch /ram/source')
    const r = await ws.shell('ln -T /ram/source /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/File exists/)
    await ws.close()
  })

  it('ln -s refuses a mount root as link name', async () => {
    const ws = twoMountWs()
    const r = await ws.shell('ln -sT /ram/source /r2')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/File exists/)
    await ws.close()
  })

  it('ln within a single mount is not blocked by the mount-root guard', async () => {
    const ws = twoMountWs()
    await ws.shell('touch /r2/source')
    const r = await ws.shell('ln -s /r2/source /r2/link')
    // The guard's "File exists" must NOT fire — link target is not a mount root.
    expect(r.stderrText).not.toMatch(/File exists/)
    await ws.close()
  })
})

describe('mount-root protection — nested mounts', () => {
  it('rm refuses a nested mount root', async () => {
    const ws = nestedWs()
    const r = await ws.shell('rm -rf /data/inner')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toMatch(/Device or resource busy/)
    await ws.close()
  })

  it('rm inside the nested mount still works', async () => {
    const ws = nestedWs()
    await ws.shell('touch /data/inner/x')
    const r = await ws.shell('rm /data/inner/x')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })

  it('rm inside the outer mount still works', async () => {
    const ws = nestedWs()
    await ws.shell('touch /data/outer-file')
    const r = await ws.shell('rm /data/outer-file')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })
})

// ════════════════════════════════════════════════════════════════════
// Read fan-out
// ════════════════════════════════════════════════════════════════════

describe('traversal fan-out — find', () => {
  it('find / -maxdepth 1 -mindepth 1 -type d lists mount prefixes', async () => {
    const ws = twoMountWs()
    const r = await ws.shell('find / -maxdepth 1 -mindepth 1 -type d')
    expect(r.exitCode).toBe(0)
    expect(r.stdoutText).toMatch(/\/r2/)
    expect(r.stdoutText).toMatch(/\/ram/)
    await ws.close()
  })

  it('find / descends into each mount and surfaces files from all', async () => {
    const ws = twoMountWs()
    await ws.shell('touch /r2/a')
    await ws.shell('touch /ram/b')
    const r = await ws.shell('find /')
    expect(r.stdoutText).toMatch(/\/r2\/a/)
    expect(r.stdoutText).toMatch(/\/ram\/b/)
    await ws.close()
  })

  it('holds a synthesized mount row to the time window', async () => {
    // -newermt lives beside the predicate tree; a mount point is held to
    // it like every real row, so a future cutoff drops it.
    const ws = twoMountWs()
    const future = await ws.shell('find / -maxdepth 1 -mindepth 1 -type d -newermt 2099-01-01')
    expect(future.exitCode).toBe(0)
    expect(future.stdoutText).toBe('')
    await ws.close()
  })

  it('find inside one mount does not leak entries from siblings', async () => {
    const ws = twoMountWs()
    await ws.shell('touch /r2/only-a')
    await ws.shell('touch /ram/only-b')
    const r = await ws.shell('find /r2')
    expect(r.stdoutText).toMatch(/\/r2\/only-a/)
    expect(r.stdoutText).not.toMatch(/\/ram/)
    await ws.close()
  })

  it('find on a single-mount workspace does not fan out', async () => {
    const ws = singleMountWs()
    await ws.shell('touch /r2/file')
    const r = await ws.shell('find /r2')
    expect(r.exitCode).toBe(0)
    expect(r.stdoutText).toMatch(/\/r2\/file/)
    await ws.close()
  })

  it('find / with nested mounts surfaces both layers', async () => {
    const ws = nestedWs()
    await ws.shell('touch /data/outer-file')
    await ws.shell('touch /data/inner/inner-file')
    const r = await ws.shell('find /')
    expect(r.stdoutText).toMatch(/\/data\/outer-file/)
    expect(r.stdoutText).toMatch(/\/data\/inner\/inner-file/)
    await ws.close()
  })

  it('find -maxdepth bounds skip too-deep nested mounts', async () => {
    const ws = nestedWs()
    await ws.shell('touch /data/inner/x')
    await ws.shell('touch /data/outer-file')
    const r = await ws.shell('find / -maxdepth 1')
    // /data is at depth 1 → included
    expect(r.stdoutText).toMatch(/\/data/)
    // /data/inner/x is at depth 3 → excluded
    expect(r.stdoutText).not.toMatch(/\/data\/inner\/x/)
    await ws.close()
  })
})

describe('traversal fan-out — grep -r', () => {
  it('grep -r at root searches across mounts', async () => {
    const ws = twoMountWs()
    await ws.shell("sh -c 'echo needle > /r2/a.txt'")
    await ws.shell("sh -c 'echo other > /ram/b.txt'")
    await ws.shell("sh -c 'echo needle > /ram/c.txt'")
    const r = await ws.shell('grep -r needle /')
    expect(r.stdoutText).toMatch(/\/r2\/a\.txt/)
    expect(r.stdoutText).toMatch(/\/ram\/c\.txt/)
    expect(r.stdoutText).not.toMatch(/\/ram\/b\.txt/)
    await ws.close()
  })
})

describe('traversal fan-out — du', () => {
  it('du / fans out across mounts', async () => {
    const ws = twoMountWs()
    await ws.shell("sh -c 'echo content > /r2/file'")
    await ws.shell("sh -c 'echo other > /ram/file'")
    const r = await ws.shell('du /')
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
    const ws = twoMountWs()
    const r = await ws.shell('ls /')
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
    const ws = twoMountWs()
    await ws.shell('touch /r2/a /r2/b')
    expect((await ws.shell('rm -I /r2/a')).exitCode).toBe(0)
    expect((await ws.shell('rm -i /r2/b')).exitCode).toBe(0)
    expect((await ws.shell('ls /r2')).stdoutText.trim()).toBe('')
    await ws.close()
  })

  it('--one-file-system is accepted and removes within the mount', async () => {
    const ws = twoMountWs()
    await ws.shell('mkdir -p /r2/d && touch /r2/d/x')
    const r = await ws.shell('rm --one-file-system -rf /r2/d')
    expect(r.exitCode).toBe(0)
    expect((await ws.shell('ls /r2')).stdoutText.trim()).toBe('')
    await ws.close()
  })

  it('--preserve-root and --no-preserve-root cannot remove a mount root', async () => {
    // mirage protection is structural: --no-preserve-root does not disable
    // it, and / gets GNU's own failsafe first (coreutils 9.7).
    const ws = twoMountWs()
    for (const [cmd, refusal] of [
      [
        'rm --preserve-root -rf /',
        "rm: it is dangerous to operate recursively on '/'\n" +
          'rm: use --no-preserve-root to override this failsafe\n',
      ],
      ['rm --no-preserve-root -rf /r2', "rm: cannot remove '/r2': Device or resource busy\n"],
    ] as const) {
      const r = await ws.shell(cmd)
      expect([r.exitCode, r.stderrText]).toEqual([1, refusal])
    }
    await ws.close()
  })

  it('rm -I no longer errors as an invalid option', async () => {
    const ws = twoMountWs()
    await ws.shell('touch /r2/a')
    const r = await ws.shell('rm -rfI /r2/a')
    expect(r.exitCode).toBe(0)
    expect(r.stderrText).not.toContain('invalid option')
    await ws.close()
  })
})
