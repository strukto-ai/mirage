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
import { IOResult, materialize } from '../../io/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { MountRegistry } from '../mount/registry.ts'
import type { MountEntry } from '../mount/mount.ts'
import { Session } from '../session/session.ts'
import type { ExecuteNodeFn } from './jobs.ts'
import type { DispatchFn } from './cross_mount.ts'
import { handleCommand } from './command.ts'
import { filterUnderPrefixes } from './fanout.ts'
import { basename } from '../../core/ram/utils.ts'
import { OpsRegistry } from '../../ops/registry.ts'
import { getTestParser, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { specFlagNames } from '../../commands/spec/types.ts'
import { specOf } from '../../commands/spec/builtins.ts'

const NEVER_EXECUTE: ExecuteNodeFn = () => {
  throw new Error('executeNode should not have been called')
}

// `find` resolves its start point through the dispatcher, because a start
// point the router followed into another mount can only be statted there.
// Anything else reaching the dispatcher is still a test failure.
const STAT_ONLY_DISPATCH: DispatchFn = ((op: string, path: PathSpec) => {
  if (op !== 'stat') throw new Error(`dispatch(${op}) should not have been called`)
  return Promise.resolve([
    new FileStat({ name: basename(path.virtual), type: FileType.DIRECTORY }),
    new IOResult(),
  ])
}) as unknown as DispatchFn

function wireMount(mount: MountEntry): void {
  const cmds = mount.resource.commands?.()
  if (cmds !== undefined) {
    for (const cmd of cmds) {
      if (cmd.filetype !== null) mount.register(cmd)
      else if (cmd.resource === null) mount.registerGeneral(cmd)
      else mount.register(cmd)
    }
  }
}

function wireRegistry(reg: MountRegistry): void {
  for (const m of reg.allMounts()) wireMount(m)
}

describe('fanOutTraversal glob matching', () => {
  it('find -name with a lone [ does not throw', async () => {
    const reg = new MountRegistry(
      { '/data/': new RAMResource(), '/data/sub/': new RAMResource() },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [, io] = await handleCommand(
      NEVER_EXECUTE,
      STAT_ONLY_DISPATCH,
      reg,
      ['find', '/data', '-name', '['],
      s,
    )
    expect(typeof io.exitCode).toBe('number')
  })

  it('find -name matches descendant mount names with [...] classes like Python', async () => {
    const reg = new MountRegistry(
      { '/data/': new RAMResource(), '/data/sub1/': new RAMResource() },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out, io] = await handleCommand(
      NEVER_EXECUTE,
      STAT_ONLY_DISPATCH,
      reg,
      ['find', '/data', '-name', 'sub[0-9]'],
      s,
    )
    expect(io.exitCode).toBe(0)
    const text = out === null ? '' : new TextDecoder().decode(await materialize(out))
    expect(text).toContain('/data/sub1')
  })
})

describe('fanOutTraversal mount-entry synthesis honors the expression tree', () => {
  async function runFind(argv: string[]): Promise<string> {
    const reg = new MountRegistry(
      {
        '/data/': new RAMResource(),
        '/data/ram/': new RAMResource(),
        '/data/disk/': new RAMResource(),
      },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out] = await handleCommand(NEVER_EXECUTE, STAT_ONLY_DISPATCH, reg, argv, s)
    return out === null ? '' : new TextDecoder().decode(await materialize(out))
  }

  it('-not -name excludes the matching mount', async () => {
    const text = await runFind(['find', '/data', '-not', '-name', 'ram'])
    expect(text).not.toContain('/data/ram')
    expect(text).toContain('/data/disk')
  })

  it('-o ORs the two name patterns', async () => {
    const text = await runFind(['find', '/data', '-name', 'ram', '-o', '-name', 'disk'])
    expect(text).toContain('/data/ram')
    expect(text).toContain('/data/disk')
  })

  it('-type f excludes mount directories', async () => {
    const text = await runFind(['find', '/data', '-type', 'f'])
    expect(text).not.toContain('/data/ram')
    expect(text).not.toContain('/data/disk')
  })
})

describe('find actions on structural rows', () => {
  function nestedGhostRegistry(): MountRegistry {
    const parent = new RAMResource()
    parent.store.files.set('/top.txt', new TextEncoder().encode('hello\n'))
    const deep = new RAMResource()
    deep.store.files.set('/leaf.txt', new TextEncoder().encode('deep\n'))
    const reg = new MountRegistry({ '/': parent, '/ghost/very/deep/': deep }, MountMode.WRITE)
    wireRegistry(reg)
    return reg
  }

  it('-ls renders namespace-only ancestor rows', async () => {
    const reg = nestedGhostRegistry()
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out, io] = await handleCommand(
      NEVER_EXECUTE,
      STAT_ONLY_DISPATCH,
      reg,
      ['find', '/', '-ls'],
      s,
    )
    expect(io.exitCode).toBe(0)
    const text = out === null ? '' : new TextDecoder().decode(await materialize(out))
    const rows = text
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split(/[\t ]+/).at(-1))
    expect(rows).toContain('/ghost')
    expect(rows).toContain('/ghost/very')
    expect(rows).toContain('/ghost/very/deep')
  })

  it('-delete skips structural rows and exits 0', async () => {
    const reg = nestedGhostRegistry()
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [, io] = await handleCommand(
      NEVER_EXECUTE,
      STAT_ONLY_DISPATCH,
      reg,
      ['find', '/', '-delete'],
      s,
    )
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(await materialize(io.stderr))).toBe('')
    const [after] = await handleCommand(NEVER_EXECUTE, STAT_ONLY_DISPATCH, reg, ['find', '/'], s)
    const text = after === null ? '' : new TextDecoder().decode(await materialize(after))
    expect(text).toContain('/ghost/very/deep')
    expect(text).not.toContain('/top.txt')
    expect(text).not.toContain('leaf.txt')
  })
})

describe('fanOutTraversal -maxdepth applies to child-mount depth', () => {
  it('a deeper child entry beyond the budget is excluded', async () => {
    const child = new RAMResource()
    child.store.dirs.add('/a')
    child.store.files.set('/a/b.txt', new TextEncoder().encode('deep\n'))
    const reg = new MountRegistry({ '/': new RAMResource(), '/data/': child }, MountMode.WRITE)
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out] = await handleCommand(
      NEVER_EXECUTE,
      STAT_ONLY_DISPATCH,
      reg,
      ['find', '/', '-maxdepth', '2'],
      s,
    )
    const text = out === null ? '' : new TextDecoder().decode(await materialize(out))
    expect(text).toContain('/data/a')
    expect(text).not.toContain('/data/a/b.txt')
  })
})

describe('filterUnderPrefixes', () => {
  it('reads du paths after the size column', async () => {
    // du renders SIZE\tPATH, so the path is the second field; reading
    // the first kept every shadowed du row in the parent's output.
    const out = await filterUnderPrefixes(
      new TextEncoder().encode('1000\t/base/inner\n1010\t/base\n'),
      ['/base/inner'],
      'du',
    )
    expect(new TextDecoder().decode(out)).toBe('1010\t/base\n')
  })

  it('still reads find and grep paths from the front', async () => {
    const found = await filterUnderPrefixes(
      new TextEncoder().encode('/base/inner/x\n/base/y\n'),
      ['/base/inner'],
      'find',
    )
    expect(new TextDecoder().decode(found)).toBe('/base/y\n')
    const grepped = await filterUnderPrefixes(
      new TextEncoder().encode('/base/inner/x:hit\n/base/y:hit\n'),
      ['/base/inner'],
      'grep',
    )
    expect(new TextDecoder().decode(grepped)).toBe('/base/y:hit\n')
  })
})

describe('fanOutTraversal du at a descendant mount boundary', () => {
  async function runLines(cmds: string[], top = 10, real = 7): Promise<string> {
    const parser = await getTestParser()
    const parent = new RAMResource()
    parent.store.files.set('/top.txt', new Uint8Array(top))
    parent.store.dirs.add('/inner')
    parent.store.files.set('/inner/leftover.txt', new Uint8Array(1000))
    const child = new RAMResource()
    child.store.files.set('/real.txt', new Uint8Array(real))
    const registry = new OpsRegistry()
    registry.registerResource(parent)
    registry.registerResource(child)
    const ws = new Workspace(
      { '/base': parent, '/base/inner': child },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    try {
      let out = ''
      for (const cmd of cmds) out = stdoutStr(await ws.execute(cmd))
      return out
    } finally {
      await ws.close()
    }
  }

  function runLine(cmd: string): Promise<string> {
    return runLines([cmd])
  }

  // A nested mount's bytes belong to every directory above it. Pinned on
  // coreutils 9.7 over a tmpfs mounted at the same spot: `du
  // --apparent-size -B1 base` prints `7 base/inner` then `17 base`,
  // children before parents. Only `-x`, which mirage does not implement,
  // reports the parent's own 10. The 1000 shadowed bytes under the mount
  // point count nowhere, in GNU or here.
  it('folds the child mount into its ancestors', async () => {
    expect(await runLine('du /base')).toBe('7\t/base/inner\n17\t/base\n')
  })

  it('hides shadowed leaves under -a', async () => {
    expect(await runLine('du -a /base')).toBe(
      '7\t/base/inner/real.txt\n7\t/base/inner\n10\t/base/top.txt\n17\t/base\n',
    )
  })

  // `-s` is one total per argument, mount boundary or not (GNU 9.7 prints
  // the single row `17 base`).
  it('is one row per operand under -s', async () => {
    expect(await runLine('du -s /base')).toBe('17\t/base\n')
  })

  // GNU `du -c` prints exactly one grand total covering everything it
  // walked. Pinned on coreutils 9.7 over a tmpfs mounted at the same spot:
  // `du -c --apparent-size -B1 base` reports `7 base/inner`, `17 base`,
  // `17 total`.
  it('prints one total across the mounts under -c', async () => {
    expect(await runLine('du -c /base')).toBe('7\t/base/inner\n17\t/base\n17\ttotal\n')
  })

  it('prints one total under -sc', async () => {
    expect(await runLine('du -sc /base')).toBe('17\t/base\n17\ttotal\n')
  })

  // `-S` reaches the merge, and the `-c` total stays recursive. Pinned on
  // coreutils 9.7 over a tmpfs mounted at the same spot: `du -bS base`
  // prints `7 base/inner` then `10 base` (the parent counts only the file
  // sitting in it), and `du -bSc base` still ends `17 total`.
  it('scopes only the rows under -S', async () => {
    expect(await runLine('du -S /base')).toBe('7\t/base/inner\n10\t/base\n')
    expect(await runLine('du -Sc /base')).toBe('7\t/base/inner\n10\t/base\n17\ttotal\n')
  })

  it('summarises direct files only under -Ss', async () => {
    expect(await runLine('du -Ss /base')).toBe('10\t/base\n')
    expect(await runLine('du -Ssc /base')).toBe('10\t/base\n17\ttotal\n')
  })

  it('lists files under -Sa across the mounts', async () => {
    expect(await runLine('du -Sa /base')).toBe(
      '7\t/base/inner/real.txt\n7\t/base/inner\n10\t/base/top.txt\n10\t/base\n',
    )
  })

  // Summing each mount's already-humanized total would round twice and
  // report 2.2K; the sub-runs render exact bytes and only the merge
  // humanizes. 1025 bytes rather than 1500 because GNU rounds up: 1500
  // doubles to 3000, which single- and double-rounding both render 3.0K,
  // so those sizes could no longer tell the two apart.
  it('humanizes the total once under -ch', async () => {
    expect(await runLines(['du -ch /base'], 1025, 1025)).toBe(
      '1.1K\t/base/inner\n2.1K\t/base\n2.1K\ttotal\n',
    )
  })

  // `--max-depth` prunes only what is printed: the mount's bytes still
  // reach the operand row.
  it('prunes printing not accounting under --max-depth', async () => {
    expect(await runLine('du --max-depth=0 /base')).toBe('17\t/base\n')
  })

  // `tree` is not fanned out at all: one root line, one drawing, one
  // summary, with the nested mount crossed inside the generic. Pinned on
  // tree 2.2.1, which draws the mounted entries under the mount point and
  // none of the ones it covers.
  it('renders tree as one document across the boundary', async () => {
    expect(await runLine('tree /base')).toBe(
      '/base\n|-- inner\n|   `-- real.txt\n`-- top.txt\n\n2 directories, 2 files\n',
    )
  })

  it('drops the shadowed ls -R group whole', async () => {
    expect(await runLine('ls -R /base')).toBe('/base:\ninner\ntop.txt\n\n/base/inner:\nreal.txt\n')
  })

  // A nested mount is not a reason for a link to disappear. GNU lists
  // `/base/link.txt` and sizes it at 13 (its target string) whether or not
  // something is mounted at `/base/inner`; the fan-out used to run every
  // sub-command link-blind, so both rows vanished.
  it('still sees symlinks in every sub-run', async () => {
    const found = await runLines(['ln -s /base/top.txt /base/link.txt', 'find /base'])
    expect(found).toContain('/base/link.txt')
    const sized = await runLines(['ln -s /base/top.txt /base/link.txt', 'du -a /base'])
    // Post-order, siblings sorted: inner, link.txt, top.txt, then the
    // operand carrying all three (7 + 13 + 10).
    expect(sized).toBe(
      '7\t/base/inner/real.txt\n7\t/base/inner\n13\t/base/link.txt\n10\t/base/top.txt\n30\t/base\n',
    )
  })
})

describe('fanOutTraversal operands spanning mounts', () => {
  async function runLine(cmd: string): Promise<string> {
    const parser = await getTestParser()
    const parent = new RAMResource()
    parent.store.files.set('/top.txt', new Uint8Array(10))
    parent.store.dirs.add('/inner')
    parent.store.files.set('/inner/leftover.txt', new Uint8Array(1000))
    const child = new RAMResource()
    child.store.files.set('/real.txt', new TextEncoder().encode('hit here\n'))
    const other = new RAMResource()
    other.store.files.set('/o.txt', new TextEncoder().encode('hit there\n'))
    const registry = new OpsRegistry()
    registry.registerResource(parent)
    registry.registerResource(child)
    registry.registerResource(other)
    const ws = new Workspace(
      { '/base': parent, '/base/inner': child, '/other': other },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    try {
      return stdoutStr(await ws.execute(cmd))
    } finally {
      await ws.close()
    }
  }

  // A per-operand native run is single-mount, so an operand holding a
  // nested mount used to report the parent's shadowed keys and none of
  // the mount's own: `du /base` and `du /base /other` disagreed about the
  // same tree. GNU counts a mounted filesystem in the same run either way.
  it('fans out inside each operand for du -c', async () => {
    expect(await runLine('du -c /base /other')).toBe(
      '9\t/base/inner\n19\t/base\n10\t/other\n29\ttotal\n',
    )
  })

  // The du merge re-derives the whole tree centrally, so the sub-runs are
  // asked with the presentation flags stripped and each one is then
  // applied once, in the merge. A flag nobody classified is neither
  // stripped nor re-applied, so it silently does nothing across a nested
  // mount, which is exactly how -S first shipped. Adding an option to
  // du's spec fails this until it is sorted into one of the two lists.
  it('accounts for every du flag', () => {
    // Applied centrally by the merge, and neutralized in the sub-runs.
    const central = ['a', 'c', 'h', 'max_depth', 's', 'separate_dirs']
    // Chooses whether a run counts the symlinks on its own mount, which
    // is a per-run question; the merge only ever sees the rows.
    const perRun = ['L', 'P']
    expect([...specFlagNames(specOf('du'))].sort()).toEqual([...central, ...perRun].sort())
  })

  // -S has to survive both fan-outs at once: the per-operand one that
  // splits the operands across mounts, and the traversal one that folds
  // `/base/inner` into `/base`. GNU (coreutils 9.7, tmpfs at the nested
  // spot) scopes -S to each printed row and keeps the grand total
  // recursive, so `/base` reports only `top.txt` while the total still
  // covers every byte.
  it('keeps -S scoped to each row across both fan-outs', async () => {
    expect(await runLine('du -Sc /base /other')).toBe(
      '9\t/base/inner\n10\t/base\n10\t/other\n29\ttotal\n',
    )
  })

  it('fans out inside each operand for find and grep -r', async () => {
    const found = await runLine('find /base /other')
    expect(found).toContain('/base/inner/real.txt')
    expect(found).not.toContain('/base/inner/leftover.txt')
    expect(await runLine('grep -r hit /base /other')).toBe(
      '/base/inner/real.txt:hit here\n/other/o.txt:hit there\n',
    )
  })

  // `ls -R` renders `PATH:` then bare names, so a line filter that reads a
  // path off every line drops the header and keeps the entries, landing
  // the shadowed `leftover.txt` in `/base`'s own group. GNU (coreutils 9.7
  // over a tmpfs at the same spot) prints the mounted directory's entries
  // under its own header, one blank line between groups.
  it('drops the shadowed ls -R group whole and separates the rest', async () => {
    expect(await runLine('ls -R /base /other')).toBe(
      '/base:\ninner\ntop.txt\n\n/base/inner:\nreal.txt\n\n/other:\no.txt\n',
    )
  })
})

// Direct port of the ls cases in tests/workspace/executor/test_fanout.py:
// a mount root is an ordinary directory entry of its parent, listed by
// the walk but never descended by it.
describe('ls -R across a mount boundary', () => {
  async function runLine(mounts: Record<string, RAMResource>, cmd: string): Promise<string> {
    const parser = await getTestParser()
    const registry = new OpsRegistry()
    for (const resource of Object.values(mounts)) registry.registerResource(resource)
    const ws = new Workspace(mounts, { mode: MountMode.WRITE, ops: registry, shellParser: parser })
    try {
      return stdoutStr(await ws.execute(cmd))
    } finally {
      await ws.close()
    }
  }

  function ram(files: Record<string, string>, dirs: string[] = []): RAMResource {
    const resource = new RAMResource()
    for (const dir of dirs) resource.store.dirs.add(dir)
    for (const [key, text] of Object.entries(files)) {
      resource.store.files.set(key, new TextEncoder().encode(text))
    }
    return resource
  }

  // Pinned on coreutils 9.7 over a tmpfs mounted at `base/nested`:
  // `ls -R base` prints `nested` in `base`'s own listing, then its group.
  // `-R` used to withhold the namespace merge and leave the whole nested
  // mount to the fan-out, which contributes the group but not the row, so
  // the row went missing wherever the parent's backend held no key of that
  // name. The mirror image of the shadowed fixture above, where the parent
  // owns keys under `inner/` and so names the mountpoint from its own
  // readdir whatever the namespace says.
  it('lists a mountpoint the parent backend cannot name', async () => {
    const mounts = {
      '/base': ram({ '/top.txt': 'T\n' }),
      '/base/nested': ram({ '/real.txt': 'hit\n' }),
    }
    expect(await runLine(mounts, 'ls -R /base')).toBe(
      '/base:\nnested\ntop.txt\n\n/base/nested:\nreal.txt\n',
    )
  })

  // The merge is per directory listed, not per operand. Pinned on
  // coreutils 9.7 over a tmpfs mounted at `base/sub/deep`: `deep` is a row
  // of `base/sub`, which is a directory the parent's own backend serves.
  it('lists a mountpoint below the operand', async () => {
    const mounts = {
      '/base': ram({ '/sub/p.txt': 'P\n' }, ['/sub']),
      '/base/sub/deep': ram({ '/real.txt': 'hit\n' }),
    }
    expect(await runLine(mounts, 'ls -R /base')).toBe(
      '/base:\nsub\n\n/base/sub:\ndeep\np.txt\n\n/base/sub/deep:\nreal.txt\n',
    )
  })

  // `/ghost` exists only because a mount lives below it, and `/` is served
  // by a backend, so the withheld merge dropped the row and the two groups
  // the walk renders from it. Only a mount root is left to the fan-out;
  // the namespace-only directories above one are this walk's, because no
  // other run renders them.
  it('lists a namespace-only ancestor under a served root', async () => {
    const mounts = {
      '/': ram({ '/top.txt': 'hello\n' }),
      '/ghost/very/deep': ram({ '/leaf.txt': 'deep\n' }),
    }
    expect(await runLine(mounts, 'ls -R /')).toMatch(
      /^\/:\ndev\nghost\ntop\.txt\n\n\/ghost:\nvery\n\n\/ghost\/very:\ndeep\n/,
    )
  })

  // `/.bash_history` is a whole mount serving a single file. GNU
  // (coreutils 9.7, `mount --bind` of one file onto another) lists a file
  // that happens to be a mountpoint as an ordinary row of its parent — no
  // '/' under -F, no block of its own. The row used to be synthesized as a
  // directory, and the fan-out ran a sub-run for the mount on top of it,
  // so the same name arrived twice in two wrong shapes.
  it('renders a file mount as one row and no group', async () => {
    const mounts = { '/': ram({ '/top.txt': 'T\n' }) }
    expect(await runLine(mounts, 'ls -aRF /')).toBe(
      '/:\n.bash_history\ndev/\ntop.txt\n\n/dev:\nnull\nzero\n',
    )
  })

  // A mount root is listed but not descended, so the shadowed group is
  // never produced rather than produced and filtered. `dropShadowedLsGroups`
  // only recognizes an absolute header, so a relative operand printed
  // `base/inner:` twice: once with the parent's shadowed `leftover.txt`,
  // once with the mount's own listing. GNU 9.7 prints the mounted
  // directory once.
  it('never descends the mount root under a relative operand', async () => {
    const mounts = {
      '/base': ram({ '/top.txt': 'TTTTTTTTTT', '/inner/leftover.txt': 'S'.repeat(1000) }, [
        '/inner',
      ]),
      '/base/inner': ram({ '/real.txt': 'RRRRRRR' }),
    }
    expect(await runLine(mounts, 'ls -R base')).toBe(
      'base:\ninner\ntop.txt\n\nbase/inner:\nreal.txt\n',
    )
  })
})

describe('traversal cancellation', () => {
  it.each([
    ['find', '/data'],
    ['du', '/data', '/other'],
  ])('forwards cancellation through %j', async (...parts) => {
    for (const source of ['caller', 'session'] as const) {
      for (const checksSignal of [false, true]) {
        const parent = new RAMResource()
        const child = new RAMResource()
        const other = new RAMResource()
        parent.store.files.set('/parent', new Uint8Array([1]))
        child.store.files.set('/child', new Uint8Array([2]))
        other.store.files.set('/other', new Uint8Array([3]))
        const reg = new MountRegistry(
          {
            '/data/': parent,
            '/data/sub/': child,
            '/other/': other,
          },
          MountMode.WRITE,
        )
        wireRegistry(reg)
        const controller = new AbortController()
        let calls = 0
        let received: AbortSignal | undefined
        for (const mount of reg.allMounts()) {
          mount.executeCmd = (_name, _paths, _texts, _flags, opts) => {
            calls++
            received = opts?.signal
            controller.abort()
            if (checksSignal) received?.throwIfAborted()
            return Promise.resolve([null, new IOResult()])
          }
        }
        const session = new Session({ sessionId: 'test', cwd: '/' })
        if (source === 'session') session.abortSignal = controller.signal
        await expect(
          handleCommand(
            NEVER_EXECUTE,
            STAT_ONLY_DISPATCH,
            reg,
            parts.map((part, index) => (index === 0 ? part : PathSpec.fromStrPath(part))),
            session,
            null,
            null,
            null,
            undefined,
            undefined,
            undefined,
            undefined,
            source === 'caller' ? controller.signal : undefined,
          ),
        ).rejects.toMatchObject({ name: 'AbortError' })
        expect(received?.aborted).toBe(true)
        expect(calls).toBe(1)
      }
    }
  })
})
