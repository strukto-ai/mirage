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
import type { Policy } from '../../../../policy/base.ts'
import type { Action, VfsContext } from '../../../../policy/types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { getTestParser } from '../../../fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { followPaths, prepareMv } from './links.ts'
import { IOResult } from '../../../../io/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'

const DEC = new TextDecoder()

class PinLinks implements Policy {
  preVfs(ctx: VfsContext): Action | null {
    if (ctx.op === 'unlink' && ctx.path.virtual.endsWith('.pinned')) {
      return { kind: 'deny', reason: 'pinned' }
    }
    return null
  }
}

class SealReads implements Policy {
  preVfs(ctx: VfsContext): Action | null {
    if (ctx.op === 'read' && ctx.path.virtual.endsWith('.sealed')) {
      return { kind: 'deny', reason: 'sealed' }
    }
    return null
  }
}

function dispatchOf(ws: Workspace): DispatchFn {
  return async (op, path, args = [], kwargs = {}) => [
    await ws.dispatch(op, path.virtual, args, kwargs),
    new IOResult(),
  ]
}

async function makeWs(policies: Policy[] = []): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      policies,
      shellParserFactory: () => Promise.resolve(parser),
    },
  )
}

function err(result: { stderr: Uint8Array | null }): string {
  return result.stderr === null ? '' : DEC.decode(result.stderr)
}

describe('followPaths and a link loop', () => {
  it('refuses the looping operand and resolves its neighbours', async () => {
    // A loop no longer fails the whole line: the operand stays as typed
    // with the walk's verdict on it.
    const ws = await makeWs()
    await ws.shell(
      'mkdir -p /data/real; ln -s /data/real /data/dlink; ln -s /data/l2 /data/l1; ln -s /data/l1 /data/l2',
    )
    const ns = ws.namespace
    const [loop, link] = followPaths(ns, [
      PathSpec.fromStrPath('/data/l1'),
      PathSpec.fromStrPath('/data/dlink'),
    ]) as PathSpec[]
    expect([loop?.virtual, loop?.walkError]).toEqual(['/data/l1', 'ELOOP'])
    expect([link?.virtual, link?.walkError]).toEqual(['/data/real', null])
    const [under] = followPaths(ns, [PathSpec.fromStrPath('/data/l1/x')], false) as PathSpec[]
    expect(under?.walkError).toBe('ELOOP')
    // lstat semantics never reach the looping name itself.
    const [kept] = followPaths(ns, [PathSpec.fromStrPath('/data/l1')], false) as PathSpec[]
    expect(kept?.walkError).toBeNull()
  })

  it('lets mv replace a looping destination like any link', async () => {
    // stat(2) of the destination fails ELOOP, which GNU mv reads as "not a
    // directory": the rename lands on the link's own name.
    const ws = await makeWs()
    await ws.shell('echo b > /data/b.txt; ln -s /data/l2 /data/l1; ln -s /data/l1 /data/l2')
    const r = await ws.shell('mv /data/b.txt /data/l1')
    expect(r.exitCode).toBe(0)
    expect(ws.namespace.isLink('/data/l1')).toBe(false)
    expect(DEC.decode((await ws.shell('cat /data/l1')).stdout)).toBe('b\n')
  })
})

it.each(['missing', 'a.txt', 'l1'])('mv replaces a loop with a symlink to %s', async (source) => {
  const ws = await makeWs()
  try {
    await ws.shell(
      `echo a > /data/a.txt; ln -s l2 /data/l1; ln -s l1 /data/l2; ln -s ${source} /data/src`,
    )
    const result = await ws.shell('mv /data/src /data/l1')
    expect(result.exitCode).toBe(0)
    expect(err(result)).toBe('')
    expect(ws.namespace.isLink('/data/src')).toBe(false)
    expect(DEC.decode((await ws.shell('readlink /data/l1')).stdout)).toBe(`${source}\n`)
  } finally {
    await ws.close()
  }
})

describe('followPaths and a relative target', () => {
  it('collapses its climb and keeps the typed name', async () => {
    // `../a` climbs from the link's own directory; left uncollapsed the
    // followed path no longer matched the word that spelled it, and every
    // command named the operand `/data/sub/../a`.
    const ws = await makeWs()
    await ws.shell(
      "mkdir -p /data/sub && printf 'x\\n' > /data/a && ln -s ../a /data/sub/al && ln -s ../nowhere /data/sub/d",
    )
    const [followed] = followPaths(ws.namespace, [
      PathSpec.fromStrPath('/data/sub/al'),
    ]) as PathSpec[]
    expect(followed?.virtual).toBe('/data/a')
    const r = await ws.shell('cd /data && wc -c sub/al && cat sub/d')
    expect(DEC.decode(r.stdout)).toBe('2 sub/al\n')
    expect(err(r)).toBe('cat: sub/d: No such file or directory\n')
  })
})

describe('ln -f on the same file', () => {
  it('refuses the same file before removing it', async () => {
    // Pinned on coreutils 9.7: `ln -sf a a` and `ln -f a a` are refused
    // and the file survives, spelled as typed on both sides; a backup
    // waives the check; a destination that is not there is not the same
    // file and becomes a self-loop, as in GNU.
    const ws = await makeWs()
    try {
      await ws.shell('printf hi > /data/a.txt')
      const cases: [string, string][] = [
        ['ln -sf /data/a.txt /data/a.txt', "'/data/a.txt' and '/data/a.txt'"],
        ['ln -f /data/a.txt /data/a.txt', "'/data/a.txt' and '/data/a.txt'"],
        ['cd /data && ln -sf a.txt ./a.txt', "'a.txt' and './a.txt'"],
        ['cd /data && ln -sfT a.txt a.txt', "'a.txt' and 'a.txt'"],
      ]
      for (const [line, wording] of cases) {
        const r = await ws.shell(line)
        expect(r.exitCode).toBe(1)
        expect(err(r)).toBe(`ln: ${wording} are the same file\n`)
        const cat = await ws.shell('cat /data/a.txt')
        expect(DEC.decode(cat.stdout)).toBe('hi')
        expect(ws.namespace.isLink('/data/a.txt')).toBe(false)
      }
      let r = await ws.shell('ln -sfb /data/a.txt /data/a.txt')
      expect(r.exitCode).toBe(0)
      const kept = await ws.shell('cat /data/a.txt~')
      expect(DEC.decode(kept.stdout)).toBe('hi')
      expect(ws.namespace.readlink('/data/a.txt')).toBe('/data/a.txt')
      r = await ws.shell('ln -sf /data/nope /data/nope')
      expect(r.exitCode).toBe(0)
      expect(ws.namespace.readlink('/data/nope')).toBe('/data/nope')
    } finally {
      await ws.close()
    }
  })
})

describe('ln -b on a directory', () => {
  it('refuses a directory destination instead of backing it up', async () => {
    // Pinned on coreutils 9.7: a backup moves a file aside, never a
    // directory, so `ln -bT a d` is refused with the directory intact
    // where mirage used to rename the whole tree to `d~`; a symlink
    // standing at the name is what -T names and is backed up; without
    // -T the directory is where the link goes.
    const ws = await makeWs()
    try {
      await ws.shell('mkdir -p /data/d; printf hi > /data/a.txt')
      for (const line of [
        'ln -sbT /data/a.txt /data/d',
        'ln -bT /data/a.txt /data/d',
        'ln -sfbT /data/a.txt /data/d',
        'ln -s --backup=numbered -T /data/a.txt /data/d',
      ]) {
        const r = await ws.shell(line)
        expect(r.exitCode).toBe(1)
        expect(err(r)).toBe('ln: /data/d: cannot overwrite directory\n')
        const ls = await ws.shell('ls /data')
        expect(DEC.decode(ls.stdout)).toBe('a.txt\nd\n')
        expect(ws.namespace.isLink('/data/d')).toBe(false)
      }
      let r = await ws.shell('ln -sb /data/a.txt /data/d')
      expect(r.exitCode).toBe(0)
      expect(ws.namespace.readlink('/data/d/a.txt')).toBe('/data/a.txt')
      await ws.shell('ln -s /data/d /data/lk')
      r = await ws.shell('ln -sbT /data/a.txt /data/lk')
      expect(r.exitCode).toBe(0)
      expect(ws.namespace.readlink('/data/lk')).toBe('/data/a.txt')
      expect(ws.namespace.readlink('/data/lk~')).toBe('/data/d')
    } finally {
      await ws.close()
    }
  })
})

describe('ln with a source it cannot read', () => {
  it('names the source and links the rest', async () => {
    // GNU names the source it cannot reach and links the rest, exit 1.
    // mirage's hard link is a byte copy, so a read the stat did not
    // foresee (a policy deny here) is that refusal, not an abort.
    const ws = await makeWs([new SealReads()])
    try {
      await ws.shell('mkdir /data/d; printf a > /data/a.sealed; printf b > /data/b.txt')
      const r = await ws.shell('ln /data/a.sealed /data/b.txt /data/d')
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe("ln: failed to access '/data/a.sealed': Permission denied\n")
      const rest = await ws.shell('ls /data/d; cat /data/d/b.txt')
      expect(DEC.decode(rest.stdout)).toBe('b.txt\nb')
    } finally {
      await ws.close()
    }
  })
})

describe('rm and unlink reach a link through the dispatcher', () => {
  it('rm of a link goes through the entry point', async () => {
    // The strip used to write the node table directly, so a preVfs
    // policy protecting a link never fired for `rm` while it fired for
    // every other entry point (the FUSE unlink hole, one tier up). The mount is
    // writable, so only the policy can be what refuses.
    const ws = await makeWs([new PinLinks()])
    try {
      await ws.shell('echo b > /data/f.txt')
      await ws.shell('ln -s f.txt /data/lk.pinned')
      const r = await ws.shell('rm /data/lk.pinned')
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe("rm: cannot remove '/data/lk.pinned': Permission denied\n")
      expect(ws.namespace.isLink('/data/lk.pinned')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('rm of a link on read turf answers like a backend file', async () => {
    // Byte for byte what `rm` of a backend file on the same grant
    // answers, because one grant must not describe itself two ways
    // depending on whether the name it stopped was a link.
    const ws = await makeWs()
    try {
      await ws.shell('echo b > /data/f.txt; ln -s f.txt /data/lk')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      const r = await ws.shell('rm /data/lk', { sessionId: 'agent' })
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe("rm: cannot remove '/data/lk': Read-only file system\n")
      expect(ws.namespace.isLink('/data/lk')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('ln and mv answer a read grant per operand', async () => {
    // Same rule for the other two verbs that write the node table: `ln`
    // answers as `touch` does on a read-only mount, and `mv` as `mv` of
    // a backend file does, in GNU's per-operand voice.
    const ws = await makeWs()
    try {
      await ws.shell('echo b > /data/f.txt; ln -s f.txt /data/lk')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      const ln = await ws.shell('ln -s f.txt /data/lk2', { sessionId: 'agent' })
      const mv = await ws.shell('mv /data/lk /data/lk3', { sessionId: 'agent' })
      expect(ln.exitCode).toBe(1)
      expect(err(ln)).toBe(
        "ln: failed to create symbolic link '/data/lk2': Read-only file system\n",
      )
      expect(mv.exitCode).toBe(1)
      expect(err(mv)).toBe("mv: cannot move '/data/lk' to '/data/lk3': Read-only file system\n")
      expect(ws.namespace.readlink('/data/lk')).toBe('f.txt')
    } finally {
      await ws.close()
    }
  })

  it('a refused link operand keeps the rest going', async () => {
    // GNU rm reports the operand it could not remove and removes the
    // others; the backend half of the line still runs and the exit code
    // says something failed.
    const ws = await makeWs([new PinLinks()])
    try {
      await ws.shell('echo b > /data/f.txt')
      await ws.shell('ln -s f.txt /data/lk.pinned; ln -s f.txt /data/lk')
      const r = await ws.shell('rm /data/lk.pinned /data/lk /data/f.txt')
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe("rm: cannot remove '/data/lk.pinned': Permission denied\n")
      expect(ws.namespace.isLink('/data/lk.pinned')).toBe(true)
      expect(ws.namespace.isLink('/data/lk')).toBe(false)
      const gone = await ws.shell('test -e /data/f.txt; echo $?')
      expect(DEC.decode(gone.stdout)).toBe('1\n')
    } finally {
      await ws.close()
    }
  })

  it('rm -f still reports a mode refusal', async () => {
    // GNU -f silences only the absent; EROFS is not ENOENT.
    const ws = await makeWs()
    try {
      await ws.shell('echo b > /data/f.txt; ln -s f.txt /data/lk')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      const r = await ws.shell('rm -f /data/lk', { sessionId: 'agent' })
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe("rm: cannot remove '/data/lk': Read-only file system\n")
    } finally {
      await ws.close()
    }
  })

  it('rm -f silences a hidden link', async () => {
    // A hidden link answers ENOENT (the no-name-leak rule), which is
    // exactly what -f silences; without -f the miss is reported.
    const ws = await makeWs()
    try {
      await ws.shell('echo b > /data/f.txt; ln -s f.txt /data/lk.sec')
      ws.createSession('agent', { profile: { paths: { hide: ['/data/lk.sec'] } } })
      const silent = await ws.shell('rm -f /data/lk.sec', { sessionId: 'agent' })
      const loud = await ws.shell('rm /data/lk.sec', { sessionId: 'agent' })
      expect(silent.exitCode).toBe(0)
      expect(err(silent)).toBe('')
      expect(loud.exitCode).toBe(1)
      expect(err(loud)).toBe("rm: cannot remove '/data/lk.sec': No such file or directory\n")
      expect(ws.namespace.isLink('/data/lk.sec')).toBe(true)
    } finally {
      await ws.close()
    }
  })
  it('every refused operand speaks in one voice', async () => {
    // GNU reports each operand it could not remove, so a read grant is
    // one line per operand -- a link the node table refuses and a
    // backend file the dispatcher refuses say the same thing.
    const ws = await makeWs()
    try {
      await ws.shell('echo b > /data/f.txt')
      await ws.shell('ln -s f.txt /data/l1; ln -s f.txt /data/l2')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      for (const operands of [
        ['l1', 'l2'],
        ['l1', 'f.txt'],
        ['l1', 'l2', 'f.txt'],
      ]) {
        const line = `rm ${operands.map((name) => `/data/${name}`).join(' ')}`
        const r = await ws.shell(line, { sessionId: 'agent' })
        expect(r.exitCode, line).toBe(1)
        expect(err(r), line).toBe(
          operands
            .map((name) => `rm: cannot remove '/data/${name}': Read-only file system\n`)
            .join(''),
        )
      }
      expect(ws.namespace.isLink('/data/l1')).toBe(true)
      expect(ws.namespace.isLink('/data/l2')).toBe(true)
    } finally {
      await ws.close()
    }
  })
})

describe('mv re-anchors what the node table holds', () => {
  it.each(['-n', '--update=none', '--update=none-fail'])(
    'applies %s to every link operand',
    async (option) => {
      for (const operands of [
        '/data/l /data/dst',
        '/data/l /data/a /data/dst',
        '-t /data/dst /data/l /data/a',
      ]) {
        const ws = await makeWs()
        try {
          await ws.shell(
            'mkdir /data/dst; echo old > /data/dst/l; ln -s missing /data/l; echo a > /data/a',
          )
          expect((await ws.shell(`mv ${option} ${operands}`)).exitCode).toBe(
            option === '--update=none-fail' ? 1 : 0,
          )
          expect(DEC.decode((await ws.shell('cat /data/dst/l')).stdout)).toBe('old\n')
          expect(DEC.decode((await ws.shell('readlink /data/l')).stdout)).toBe('missing\n')
        } finally {
          await ws.close()
        }
      }
    },
  )

  it('follows a linked destination for many sources', async () => {
    // GNU stats the destination of `mv a b dlink` through the link, so the
    // generic mv is handed the directory it names (coreutils 9.7), and each
    // source lands inside it.
    const ws = await makeWs()
    try {
      await ws.shell('mkdir -p /data/dst; printf a > /data/a; printf b > /data/b')
      await ws.shell('ln -s /data/dst /data/dlink')
      const items = [
        PathSpec.fromStrPath('/data/a'),
        PathSpec.fromStrPath('/data/b'),
        new PathSpec({
          virtual: '/data/dlink',
          directory: '/data/',
          vfsPath: 'dlink',
          rawPath: 'dlink',
        }),
      ]
      const prepared = await prepareMv(
        ws.namespace,
        dispatchOf(ws),
        items,
        ['a', 'b', 'dlink'],
        '/data',
      )
      expect(prepared.early).toBeNull()
      const dst = prepared.items[prepared.items.length - 1]
      expect(dst instanceof PathSpec ? [dst.virtual, dst.rawPath] : null).toEqual([
        '/data/dst',
        'dlink',
      ])
    } finally {
      await ws.close()
    }
  })

  it('leaves link sources for the generic', async () => {
    // A link has no backend entry for the generic mv to move, so a
    // several-source mv lost it (`mv: cannot stat 'l'`); the namespace
    // renames it into the directory and the rest go to the backend.
    const ws = await makeWs()
    try {
      await ws.shell('mkdir -p /data/dst; printf a > /data/a')
      await ws.shell('ln -s /data/a /data/l')
      const link = PathSpec.fromStrPath('/data/l')
      const prepared = await prepareMv(
        ws.namespace,
        dispatchOf(ws),
        [link, PathSpec.fromStrPath('/data/a'), PathSpec.fromStrPath('/data/dst')],
        ['/data/l', '/data/a', '/data/dst'],
        '/',
      )
      expect(prepared.early).toBeNull()
      expect(prepared.items).toContain(link)
      expect(ws.namespace.isLink('/data/dst/l')).toBe(false)
      expect(ws.namespace.isLink('/data/l')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it.each([false, true])(
    'reanchors only completed sources in a partial move (skip=%s)',
    async (skip) => {
      const ws = await makeWs()
      try {
        await ws.shell(
          'mkdir -p /data/src /data/out/src; echo x > /data/src/f; ln -s f /data/src/l',
        )
        expect(
          (await ws.shell(`mv ${skip ? '-n' : ''} /data/missing /data/src /data/out`)).exitCode,
        ).toBe(1)
        const kept = skip ? '/data/src/l' : '/data/out/src/l'
        const absent = skip ? '/data/out/src/l' : '/data/src/l'
        expect(DEC.decode((await ws.shell(`cat ${kept}`)).stdout)).toBe('x\n')
        expect(ws.namespace.isLink(absent)).toBe(false)
      } finally {
        await ws.close()
      }
    },
  )

  it('moves a link below a renamed directory with it', async () => {
    const ws = await makeWs()
    try {
      await ws.shell('mkdir -p /data/d; printf t > /data/t')
      await ws.shell('ln -s /data/t /data/d/link')
      expect((await ws.shell('mv /data/d /data/moved')).exitCode).toBe(0)
      const told = await ws.shell('readlink /data/moved/link')
      expect([told.exitCode, DEC.decode(told.stdout)]).toEqual([0, '/data/t\n'])
      expect((await ws.shell('readlink /data/d/link')).exitCode).not.toBe(0)
    } finally {
      await ws.close()
    }
  })
})

it.each(['missing', 'a.txt', 'loop'])(
  'keeps the %s link when the move destination loops',
  async (source) => {
    const ws = await makeWs()
    try {
      await ws.shell(`cd /data; echo hello > a.txt; ln -s loop loop; ln -s ${source} src`)
      const result = await ws.shell('cd /data; mv src loop/child')
      expect(result.exitCode).toBe(1)
      expect(err(result)).toBe("mv: cannot stat 'loop/child': Too many levels of symbolic links\n")
      expect(ws.namespace.isLink('/data/src')).toBe(true)
    } finally {
      await ws.close()
    }
  },
)

class RefuseLinkCreation implements Policy {
  preVfs(ctx: VfsContext): Action | null {
    return ctx.op === 'symlink' && ctx.path.virtual === '/other/tree/loop'
      ? { kind: 'deny', reason: 'sealed' }
      : null
  }
}

it.each([null, 'read', 'unlink', 'symlink'] as const)(
  'cross-mount mv preserves tree links with %s failure',
  async (failure) => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/other': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        policies:
          failure === 'read'
            ? [new SealReads()]
            : failure === 'unlink'
              ? [new PinLinks()]
              : failure === 'symlink'
                ? [new RefuseLinkCreation()]
                : [],
        shellParserFactory: () => Promise.resolve(parser),
      },
    )
    try {
      const setup = await ws.shell(
        'mkdir -p /data/tree/sub; printf kept > /data/tree/sub/file; ' +
          'printf sealed > /data/tree/file.sealed; ' +
          'ln -s sub /data/tree/dir; ln -s sub/file /data/tree/file; ' +
          'ln -s missing /data/tree/dangling; ln -s loop /data/tree/loop; ' +
          'ln -s sub /data/tree/link.pinned',
      )
      expect(setup.exitCode).toBe(0)
      const result = await ws.shell('mv /data/tree /other/tree')
      expect(result.exitCode).toBe(failure === null ? 0 : 1)
      expect(err(result)).toBe(
        failure === 'read'
          ? "mv: cannot open '/data/tree/file.sealed' for reading: Permission denied\n"
          : failure === 'unlink'
            ? "mv: cannot remove '/data/tree/link.pinned': Permission denied\n"
            : failure === 'symlink'
              ? "mv: cannot create symbolic link '/other/tree/loop': Permission denied\n"
              : '',
      )
      const links = {
        dir: 'sub',
        file: 'sub/file',
        dangling: 'missing',
        loop: 'loop',
        'link.pinned': 'sub',
      }
      for (const [name, target] of Object.entries(links)) {
        if (failure === 'symlink' && name === 'loop') {
          expect(ws.namespace.isLink(`/other/tree/${name}`)).toBe(false)
        } else {
          expect(ws.namespace.readlink(`/other/tree/${name}`)).toBe(target)
        }
        expect(ws.namespace.isLink(`/data/tree/${name}`)).toBe(
          failure === 'read' ||
            failure === 'symlink' ||
            (failure === 'unlink' && name === 'link.pinned'),
        )
      }
      expect(DEC.decode((await ws.shell('cat /other/tree/dir/file /other/tree/file')).stdout)).toBe(
        'keptkept',
      )
      expect((await ws.shell('test -e /data/tree')).exitCode).toBe(failure === null ? 1 : 0)
      expect((await ws.shell('test -e /data/tree/sub/file')).exitCode).toBe(
        failure === 'read' || failure === 'symlink' ? 0 : 1,
      )
    } finally {
      await ws.close()
    }
  },
)

it.each(['/data', '/other'])(
  'mv to %s keeps directory links only in the backup',
  async (destination) => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/other': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      const setup = await ws.shell(
        `mkdir -p /data/src ${destination}/dst/sub; ` +
          `printf old > ${destination}/dst/sub/file; ` +
          `ln -s sub ${destination}/dst/link; ` +
          `ln -s missing ${destination}/dst/dangling; ` +
          'printf new > /data/src/new',
      )
      expect(setup.exitCode).toBe(0)
      const result = await ws.shell(`mv -bT /data/src ${destination}/dst`)
      expect(result.exitCode).toBe(0)
      expect(err(result)).toBe('')
      expect(ws.namespace.readlink(`${destination}/dst~/link`)).toBe('sub')
      expect(ws.namespace.readlink(`${destination}/dst~/dangling`)).toBe('missing')
      expect(ws.namespace.isLink(`${destination}/dst/link`)).toBe(false)
      expect(ws.namespace.isLink(`${destination}/dst/dangling`)).toBe(false)
      expect(
        DEC.decode(
          (await ws.shell(`cat ${destination}/dst/new ${destination}/dst~/link/file`)).stdout,
        ),
      ).toBe('newold')
      expect((await ws.shell(`test -e ${destination}/dst/sub`)).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  },
)

for (const destination of ['/data', '/other']) {
  for (const sourceLink of [false, true]) {
    it.each(['safe', 'missing', 'dst~', 'dir'])(
      `cp backup at ${destination} preserves %s referent (source link: ${String(sourceLink)})`,
      async (backupTarget) => {
        const parser = await getTestParser()
        const ws = new Workspace(
          { '/data': new RAMVFS(), '/other': new RAMVFS() },
          { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
        )
        try {
          const setup = await ws.shell(
            `mkdir -p ${destination}/dir; printf safe > ${destination}/safe; ` +
              `printf child > ${destination}/dir/file; printf old > ${destination}/dst; ` +
              `ln -s ${backupTarget} ${destination}/dst~; ` +
              (sourceLink ? 'ln -s absent /data/src' : 'printf new > /data/src'),
          )
          expect(setup.exitCode).toBe(0)
          const result = await ws.shell(`cp -Pb /data/src ${destination}/dst`)
          expect(result.exitCode).toBe(0)
          expect(err(result)).toBe('')
          expect(ws.namespace.isLink(`${destination}/dst~`)).toBe(false)
          const content = await ws.shell(
            `cat ${destination}/dst~ ${destination}/safe ${destination}/dir/file`,
          )
          expect(DEC.decode(content.stdout)).toBe('oldsafechild')
          expect((await ws.shell(`test -e ${destination}/missing`)).exitCode).toBe(1)
          if (sourceLink) expect(ws.namespace.readlink(`${destination}/dst`)).toBe('absent')
          else expect(DEC.decode((await ws.shell(`cat ${destination}/dst`)).stdout)).toBe('new')
        } finally {
          await ws.close()
        }
      },
    )
  }
}

it.each([false, true])(
  'cp backup unlink refusal preserves destination (source link: %s)',
  async (sourceLink) => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/other': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        policies: [new PinLinks()],
        shellParserFactory: () => Promise.resolve(parser),
      },
    )
    try {
      const setup = await ws.shell(
        'printf safe > /other/safe; printf old > /other/dst; ln -s safe /other/dst.pinned; ' +
          (sourceLink ? 'ln -s absent /data/src' : 'printf new > /data/src'),
      )
      expect(setup.exitCode).toBe(0)
      const result = await ws.shell('cp -Pb --suffix=.pinned /data/src /other/dst')
      expect(result.exitCode).toBe(1)
      expect(err(result)).toBe("cp: cannot backup '/other/dst': Permission denied\n")
      expect(ws.namespace.readlink('/other/dst.pinned')).toBe('safe')
      expect(DEC.decode((await ws.shell('cat /other/dst /other/safe')).stdout)).toBe('oldsafe')
      expect((await ws.shell('test -e /data/src || test -L /data/src')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  },
)

for (const command of ['cp -P', 'mv']) {
  it.each(['/data', '/other'])(
    `${command} counts namespace links in numbered backups at %s`,
    async (destination) => {
      const parser = await getTestParser()
      const ws = new Workspace(
        { '/data': new RAMVFS(), '/other': new RAMVFS() },
        { mode: MountMode.WRITE, shellParserFactory: () => Promise.resolve(parser) },
      )
      try {
        const setup = await ws.shell(
          `printf old > ${destination}/dst; ln -s missing ${destination}/dst.~1~; printf new > /data/src`,
        )
        expect(setup.exitCode).toBe(0)
        const result = await ws.shell(`${command} --backup=numbered /data/src ${destination}/dst`)
        expect(result.exitCode).toBe(0)
        expect(ws.namespace.readlink(`${destination}/dst.~1~`)).toBe('missing')
        expect(
          DEC.decode((await ws.shell(`cat ${destination}/dst ${destination}/dst.~2~`)).stdout),
        ).toBe('newold')
      } finally {
        await ws.close()
      }
    },
  )
}
