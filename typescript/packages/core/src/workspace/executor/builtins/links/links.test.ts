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
import type { Action, OpsContext } from '../../../../policy/types.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { getTestParser } from '../../../fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { prepareMv } from './links.ts'
import { IOResult } from '../../../../io/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'

const DEC = new TextDecoder()

class PinLinks implements Policy {
  preOps(ctx: OpsContext): Action | null {
    if (ctx.op === 'unlink' && ctx.path.virtual.endsWith('.pinned')) {
      return { kind: 'deny', reason: 'pinned' }
    }
    return null
  }
}

class SealReads implements Policy {
  preOps(ctx: OpsContext): Action | null {
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
    { '/data': new RAMResource() },
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

describe('ln -f on the same file', () => {
  it('refuses the same file before removing it', async () => {
    // Pinned on coreutils 9.7: `ln -sf a a` and `ln -f a a` are refused
    // and the file survives, spelled as typed on both sides; a backup
    // waives the check; a destination that is not there is not the same
    // file and becomes a self-loop, as in GNU.
    const ws = await makeWs()
    try {
      await ws.execute('printf hi > /data/a.txt')
      const cases: [string, string][] = [
        ['ln -sf /data/a.txt /data/a.txt', "'/data/a.txt' and '/data/a.txt'"],
        ['ln -f /data/a.txt /data/a.txt', "'/data/a.txt' and '/data/a.txt'"],
        ['cd /data && ln -sf a.txt ./a.txt', "'a.txt' and './a.txt'"],
        ['cd /data && ln -sfT a.txt a.txt', "'a.txt' and 'a.txt'"],
      ]
      for (const [line, wording] of cases) {
        const r = await ws.execute(line)
        expect(r.exitCode).toBe(1)
        expect(err(r)).toBe(`ln: ${wording} are the same file\n`)
        const cat = await ws.execute('cat /data/a.txt')
        expect(DEC.decode(cat.stdout)).toBe('hi')
        expect(ws.namespace.isLink('/data/a.txt')).toBe(false)
      }
      let r = await ws.execute('ln -sfb /data/a.txt /data/a.txt')
      expect(r.exitCode).toBe(0)
      const kept = await ws.execute('cat /data/a.txt~')
      expect(DEC.decode(kept.stdout)).toBe('hi')
      expect(ws.namespace.readlink('/data/a.txt')).toBe('/data/a.txt')
      r = await ws.execute('ln -sf /data/nope /data/nope')
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
      await ws.execute('mkdir -p /data/d; printf hi > /data/a.txt')
      for (const line of [
        'ln -sbT /data/a.txt /data/d',
        'ln -bT /data/a.txt /data/d',
        'ln -sfbT /data/a.txt /data/d',
        'ln -s --backup=numbered -T /data/a.txt /data/d',
      ]) {
        const r = await ws.execute(line)
        expect(r.exitCode).toBe(1)
        expect(err(r)).toBe('ln: /data/d: cannot overwrite directory\n')
        const ls = await ws.execute('ls /data')
        expect(DEC.decode(ls.stdout)).toBe('a.txt\nd\n')
        expect(ws.namespace.isLink('/data/d')).toBe(false)
      }
      let r = await ws.execute('ln -sb /data/a.txt /data/d')
      expect(r.exitCode).toBe(0)
      expect(ws.namespace.readlink('/data/d/a.txt')).toBe('/data/a.txt')
      await ws.execute('ln -s /data/d /data/lk')
      r = await ws.execute('ln -sbT /data/a.txt /data/lk')
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
      await ws.execute('mkdir /data/d; printf a > /data/a.sealed; printf b > /data/b.txt')
      const r = await ws.execute('ln /data/a.sealed /data/b.txt /data/d')
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe("ln: failed to access '/data/a.sealed': Permission denied\n")
      const rest = await ws.execute('ls /data/d; cat /data/d/b.txt')
      expect(DEC.decode(rest.stdout)).toBe('b.txt\nb')
    } finally {
      await ws.close()
    }
  })
})

describe('rm and unlink reach a link through the op door', () => {
  it('rm of a link goes through the door', async () => {
    // The strip used to write the node table directly, so a preOps
    // policy protecting a link never fired for `rm` while it fired for
    // every other door (the FUSE unlink hole, one tier up). The mount is
    // writable, so only the policy can be what refuses.
    const ws = await makeWs([new PinLinks()])
    try {
      await ws.execute('echo b > /data/f.txt')
      await ws.execute('ln -s f.txt /data/lk.pinned')
      const r = await ws.execute('rm /data/lk.pinned')
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe("rm: cannot remove '/data/lk.pinned': Permission denied\n")
      expect(ws.namespace.isLink('/data/lk.pinned')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('rm of a link on read turf names the mount', async () => {
    // The mount voice, byte for byte what `rm` of a backend file on the
    // same grant answers, because one grant must not describe itself two
    // ways depending on whether the name it stopped was a link.
    const ws = await makeWs()
    try {
      await ws.execute('echo b > /data/f.txt; ln -s f.txt /data/lk')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      const r = await ws.execute('rm /data/lk', { sessionId: 'agent' })
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe('rm: read-only mount at /data/\n')
      expect(ws.namespace.isLink('/data/lk')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('ln and mv name the mount too', async () => {
    // Same rule for the other two verbs that write the node table: `ln`
    // answers as `touch` does on a read-only mount, and `mv` as `mv` of
    // a backend file does.
    const ws = await makeWs()
    try {
      await ws.execute('echo b > /data/f.txt; ln -s f.txt /data/lk')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      const ln = await ws.execute('ln -s f.txt /data/lk2', { sessionId: 'agent' })
      const mv = await ws.execute('mv /data/lk /data/lk3', { sessionId: 'agent' })
      expect(ln.exitCode).toBe(1)
      expect(err(ln)).toBe('ln: read-only mount at /data/\n')
      expect(mv.exitCode).toBe(1)
      expect(err(mv)).toBe('mv: read-only mount at /data/\n')
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
      await ws.execute('echo b > /data/f.txt')
      await ws.execute('ln -s f.txt /data/lk.pinned; ln -s f.txt /data/lk')
      const r = await ws.execute('rm /data/lk.pinned /data/lk /data/f.txt')
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe("rm: cannot remove '/data/lk.pinned': Permission denied\n")
      expect(ws.namespace.isLink('/data/lk.pinned')).toBe(true)
      expect(ws.namespace.isLink('/data/lk')).toBe(false)
      const gone = await ws.execute('test -e /data/f.txt; echo $?')
      expect(DEC.decode(gone.stdout)).toBe('1\n')
    } finally {
      await ws.close()
    }
  })

  it('rm -f still reports a mode refusal', async () => {
    // GNU -f silences only the absent; EROFS is not ENOENT.
    const ws = await makeWs()
    try {
      await ws.execute('echo b > /data/f.txt; ln -s f.txt /data/lk')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      const r = await ws.execute('rm -f /data/lk', { sessionId: 'agent' })
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe('rm: read-only mount at /data/\n')
    } finally {
      await ws.close()
    }
  })

  it('rm -f silences a hidden link', async () => {
    // A hidden link answers ENOENT (the no-name-leak rule), which is
    // exactly what -f silences; without -f the miss is reported.
    const ws = await makeWs()
    try {
      await ws.execute('echo b > /data/f.txt; ln -s f.txt /data/lk.sec')
      ws.createSession('agent', { profile: { paths: { hide: ['/data/lk.sec'] } } })
      const silent = await ws.execute('rm -f /data/lk.sec', { sessionId: 'agent' })
      const loud = await ws.execute('rm /data/lk.sec', { sessionId: 'agent' })
      expect(silent.exitCode).toBe(0)
      expect(err(silent)).toBe('')
      expect(loud.exitCode).toBe(1)
      expect(err(loud)).toBe("rm: cannot remove '/data/lk.sec': No such file or directory\n")
      expect(ws.namespace.isLink('/data/lk.sec')).toBe(true)
    } finally {
      await ws.close()
    }
  })
  it('one read-only mount speaks once', async () => {
    // The refusal names the mount, not the operand, so it is one fact
    // however many operands tripped it -- including the backend operands
    // the command tier refuses separately, whose line is the same line.
    const ws = await makeWs()
    try {
      await ws.execute('echo b > /data/f.txt')
      await ws.execute('ln -s f.txt /data/l1; ln -s f.txt /data/l2')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      for (const line of [
        'rm /data/l1 /data/l2',
        'rm /data/l1 /data/f.txt',
        'rm /data/l1 /data/l2 /data/f.txt',
      ]) {
        const r = await ws.execute(line, { sessionId: 'agent' })
        expect(r.exitCode, line).toBe(1)
        expect(err(r), line).toBe('rm: read-only mount at /data/\n')
      }
      expect(ws.namespace.isLink('/data/l1')).toBe(true)
      expect(ws.namespace.isLink('/data/l2')).toBe(true)
    } finally {
      await ws.close()
    }
  })
})

describe('mv re-anchors what the node table holds', () => {
  it('hands back the pair whatever the table holds at the source', async () => {
    // Gated on the source carrying overlay attrs, the pair was withheld
    // for a directory whose own node is empty, and every link below it
    // stayed at the emptied name: readable nowhere, since no backend
    // holds an entry for a link at all.
    const ws = await makeWs()
    try {
      await ws.execute('mkdir -p /data/d; printf t > /data/t')
      await ws.execute('ln -s /data/t /data/d/link')
      const prepared = await prepareMv(
        ws.namespace,
        dispatchOf(ws),
        [PathSpec.fromStrPath('/data/d'), PathSpec.fromStrPath('/data/moved')],
        ['/data/d', '/data/moved'],
        '/',
      )
      expect(prepared.early).toBeNull()
      expect(prepared.postUnlink).toBe('/data/moved')
      expect(prepared.postRename).toEqual(['/data/d', '/data/moved'])
    } finally {
      await ws.close()
    }
  })

  it('reads the destination off the parsed line', async () => {
    // -T names the destination outright, so no basename is appended to
    // it, and -t makes every positional a source, which is the shape a
    // two-operand pair cannot describe at all.
    const ws = await makeWs()
    try {
      await ws.execute('mkdir -p /data/dst; printf a > /data/a')
      const pair = [PathSpec.fromStrPath('/data/a'), PathSpec.fromStrPath('/data/dst')]
      const dispatch = dispatchOf(ws)
      const into = await prepareMv(ws.namespace, dispatch, pair, ['/data/a', '/data/dst'], '/')
      expect(into.postRename).toEqual(['/data/a', '/data/dst/a'])
      const onto = await prepareMv(
        ws.namespace,
        dispatch,
        pair,
        ['-T', '/data/a', '/data/dst'],
        '/',
      )
      expect(onto.postRename).toEqual(['/data/a', '/data/dst'])
      const many = await prepareMv(
        ws.namespace,
        dispatch,
        pair,
        ['-t', '/data/dst', '/data/a'],
        '/',
      )
      expect(many.postRename).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('moves a link below a renamed directory with it', async () => {
    const ws = await makeWs()
    try {
      await ws.execute('mkdir -p /data/d; printf t > /data/t')
      await ws.execute('ln -s /data/t /data/d/link')
      expect((await ws.execute('mv /data/d /data/moved')).exitCode).toBe(0)
      const told = await ws.execute('readlink /data/moved/link')
      expect([told.exitCode, DEC.decode(told.stdout)]).toEqual([0, '/data/t\n'])
      expect((await ws.execute('readlink /data/d/link')).exitCode).not.toBe(0)
    } finally {
      await ws.close()
    }
  })
})
