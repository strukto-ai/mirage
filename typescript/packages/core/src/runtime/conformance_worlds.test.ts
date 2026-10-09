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
import { FileType, MountMode } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { MontyRuntime } from './python/monty/index.ts'

// One world, three surfaces, one dispatcher: the TS half of the conformance
// worlds (python/tests/runtime/test_conformance_worlds.py). The suite
// pins the facts a mount tree must present identically through the
// shell (virtual commands) and a sandboxed guest (its own stdlib); the
// FUSE surface lives in @struktoai/mirage-node, whose core routes every
// op through the same Workspace.dispatch these tests exercise.
//
// R1 (mount structure into the dispatcher: readdir/stat merge child mounts
// and namespace links behind the session guard, fan-out and the ls
// fact session-filtered) has landed, which is why the structure and
// enumeration groups run unmarked. So has R2 (one guarded entry point for
// every op): the confinement group was always green here, because a
// TypeScript guest reaches the dispatcher through the same async context
// that holds the session, where Python had to re-bind it across a
// thread hop. Facts still broken run as it.fails with the reason
// beside them, and start passing loud when fixed.

async function structureWorld(): Promise<Workspace> {
  const parser = await getTestParser()
  const base = new RAMVFS()
  const inner = new RAMVFS()
  const ws = new Workspace(
    {},
    { mode: MountMode.EXEC, shellParser: parser, runtimes: [new MontyRuntime(), 'workspace'] },
  )
  ws.addMount('/base', base, MountMode.WRITE)
  ws.addMount('/base/inner', inner, MountMode.WRITE)
  // Seeded through `ws.vfs`, not the shell: a shell line would be
  // recorded into /.bash_history, which every session may read, and the
  // scoped-world tests would then find the seed line instead of a leak.
  await ws.vfs.write('/base/a.txt', 'top')
  await ws.vfs.write('/base/inner/deep.txt', 'needle')
  return ws
}

/**
 * Two mounts, a profile that hides the second.
 *
 * `/open` (`pub.txt`) is reachable by session `agent`; `/closed`
 * (`sec.txt`) is hidden from it. A hide, not an omitted mount: a profile
 * narrows what it names and a mount it never names keeps its own mode,
 * so hiding is how a deployment puts a mount out of reach, and it
 * answers ENOENT rather than a refusal naming what the profile cannot see.
 */
async function scopedWorld(): Promise<Workspace> {
  const parser = await getTestParser()
  const open = new RAMVFS()
  const closed = new RAMVFS()
  const ws = new Workspace(
    {},
    { mode: MountMode.EXEC, shellParser: parser, runtimes: [new MontyRuntime(), 'workspace'] },
  )
  ws.addMount('/open', open, MountMode.WRITE)
  ws.addMount('/closed', closed, MountMode.WRITE)
  await ws.vfs.write('/open/pub.txt', 'public')
  await ws.vfs.write('/closed/sec.txt', 'SECRET-xyz')
  ws.createSession('agent', { profile: { paths: { hide: ['/closed'] } } })
  return ws
}

async function run(
  ws: Workspace,
  line: string,
  sessionId?: string,
): Promise<[number, string, string]> {
  const io = await ws.shell(line, sessionId !== undefined ? { sessionId } : undefined)
  return [io.exitCode, stdoutStr(io), stderrStr(io)]
}

// ── Group 1: nested mount + namespace link are visible to every surface ──

describe('structure world', () => {
  it('shell lists the child mount and the namespace link', async () => {
    const ws = await structureWorld()
    try {
      expect((await run(ws, 'ln -s /base/inner /base/lnk'))[0]).toBe(0)
      const [code, out] = await run(ws, 'ls /base')
      expect(code).toBe(0)
      expect(out).toContain('a.txt')
      expect(out).toContain('inner')
      expect(out).toContain('lnk')
    } finally {
      await ws.close()
    }
  })

  it('shell walk reaches a nested descendant', async () => {
    const ws = await structureWorld()
    try {
      const [code, out] = await run(ws, 'grep -r needle /base')
      expect(code).toBe(0)
      expect(out).toContain('/base/inner/deep.txt')
    } finally {
      await ws.close()
    }
  })

  it('link ancestors synthesize on every surface', async () => {
    // ln refuses /ghost/deep/lnk with no backend serving /ghost
    // (symlink(2)'s ENOENT), but a node table restored from an older
    // snapshot can still hold one; its ancestors synthesize exactly as
    // nested mount prefixes do, so `ls /` shows the way in and a guest
    // walk from the root reaches the link.
    const ws = await structureWorld()
    try {
      const [refused, , why] = await run(ws, 'ln -s /base/a.txt /ghost/deep/lnk')
      expect(refused).toBe(1)
      expect(why).toContain('No such file or directory')
      await ws.namespace.symlink('/ghost/deep/lnk', '/base/a.txt', 0)
      const stat = await ws.stat('/ghost')
      expect((stat as { type: FileType | null }).type).toBe(FileType.DIRECTORY)
      const [code, out] = await run(ws, 'ls /')
      expect(code).toBe(0)
      expect(out).toContain('ghost')
      const [ghostCode, ghostOut] = await run(ws, 'ls /ghost')
      expect(ghostCode).toBe(0)
      expect(ghostOut).toContain('deep')
      // No guest probe here: a ts guest serves only paths under a
      // visible mount, and /ghost (like / itself) is not one — the
      // documented root-anchor divergence from python, whose guests
      // fall through to dispatch and do walk the synthesized chain.
    } finally {
      await ws.close()
    }
  })

  it('a namespace-only ancestor serves every ls variant', async () => {
    // A mount at /ghost/deep gives /ghost no backend, so the dispatcher alone
    // says it exists; plain ls, ls -R (whose walk runs through the
    // cross-mount fan-out) and ls -d must all agree instead of
    // reporting the operand missing.
    const parser = await getTestParser()
    const base = new RAMVFS()
    const deep = new RAMVFS()
    const ws = new Workspace(
      {},
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new MontyRuntime(), 'workspace'],
      },
    )
    ws.addMount('/base', base, MountMode.WRITE)
    ws.addMount('/ghost/deep', deep, MountMode.WRITE)
    await ws.vfs.write('/base/a.txt', 'top')
    await ws.vfs.write('/ghost/deep/x.txt', 'inside')
    try {
      const [rCode, rOut] = await run(ws, 'ls -R /ghost')
      expect(rCode).toBe(0)
      expect(rOut).toContain('/ghost:')
      expect(rOut).toContain('deep')
      expect(rOut).toContain('x.txt')
      const [dCode, dOut] = await run(ws, 'ls -d /ghost')
      expect(dCode).toBe(0)
      expect(dOut.trim()).toBe('/ghost')
    } finally {
      await ws.close()
    }
  })
})

// ── Group 3: a scoped session confines every surface ──

describe('scoped world', () => {
  it.each([
    'cat /closed/sec.txt',
    'ls /closed',
    'grep -r SECRET /closed',
    'find /closed',
    'du /closed',
  ])('an explicit operand at the boundary reads as absent: %s', async (line) => {
    // The wording is the whole point: "not allowed" would confirm that
    // something is there, so a hide answers what an agent would see for
    // any path that was never mounted.
    const ws = await scopedWorld()
    try {
      const [code, , err] = await run(ws, line, 'agent')
      expect(code).not.toBe(0)
      expect(err).toContain('No such file or directory')
      expect(err).toContain('/closed')
      expect(err).not.toContain('not allowed')
    } finally {
      await ws.close()
    }
  })

  it('a scoped session cannot learn a hidden name from the root listing', async () => {
    const ws = await scopedWorld()
    try {
      const [code, out] = await run(ws, 'ls /', 'agent')
      expect(code).toBe(0)
      expect(out).toContain('open')
      expect(out).not.toContain('closed')
    } finally {
      await ws.close()
    }
  })

  it('a link below a hidden mount stays out of a scoped listing', async () => {
    // The link's path discloses the same name childMountNames already
    // filters, so the same hide filters it; the unrestricted view
    // keeps the link.
    const ws = await scopedWorld()
    try {
      expect((await run(ws, 'ln -s /closed/sec.txt /closed/leak'))[0]).toBe(0)
      const [code, out] = await run(ws, 'ls /', 'agent')
      expect(code).toBe(0)
      expect(out).not.toContain('closed')
      const [openCode, openOut] = await run(ws, 'ls /')
      expect(openCode).toBe(0)
      expect(openOut).toContain('closed')
    } finally {
      await ws.close()
    }
  })

  it.each([
    ['grep -r SECRET /', 'SECRET-xyz'],
    ['ls -R /', 'sec.txt'],
    ['find /', '/closed/sec.txt'],
    ['du -a /', '/closed'],
  ])('a fan-out from / does not cross the boundary: %s', async (line, needle) => {
    const ws = await scopedWorld()
    try {
      const [, out] = await run(ws, line, 'agent')
      expect(out).not.toContain(needle)
    } finally {
      await ws.close()
    }
  })

  it.each([
    ['find /base', 'leftover'],
    ['grep -r SHADOWED /base', 'SHADOWED-xyz'],
  ])('a fan-out hides shadowed keys when the descendant is hidden: %s', async (line, needle) => {
    // The parent backend holds a key under the hidden mount's prefix
    // (seeded before that mount exists, so dispatch lands it in the
    // parent). With no visible descendant the fan-out must still
    // engage: skipping it hands the walk to single-mount dispatch,
    // which serves the shadowed key that path dispatch itself
    // refuses.
    const parser = await getTestParser()
    const base = new RAMVFS()
    const inner = new RAMVFS()
    const ws = new Workspace(
      {},
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new MontyRuntime(), 'workspace'],
      },
    )
    ws.addMount('/base', base, MountMode.WRITE)
    await ws.vfs.write('/base/a.txt', 'top')
    await ws.vfs.mkdir('/base/inner')
    await ws.vfs.write('/base/inner/leftover.txt', 'SHADOWED-xyz')
    ws.addMount('/base/inner', inner, MountMode.WRITE)
    await ws.vfs.write('/base/inner/deep.txt', 'needle')
    ws.createSession('agent', { profile: { paths: { hide: ['/base/inner'] } } })
    try {
      const [, out] = await run(ws, line, 'agent')
      expect(out).not.toContain(needle)
      expect(out).not.toContain('inner')
    } finally {
      await ws.close()
    }
  })

  it('a confined guest cannot read a hidden mount', async () => {
    const ws = await scopedWorld()
    try {
      const [code, out] = await run(
        ws,
        `python3 -c "from pathlib import Path; print(Path('/closed/sec.txt').read_text())"`,
        'agent',
      )
      expect(code).not.toBe(0)
      expect(out).not.toContain('SECRET-xyz')
    } finally {
      await ws.close()
    }
  })

  it('a confined guest cannot write a hidden mount', async () => {
    const ws = await scopedWorld()
    try {
      await run(
        ws,
        `python3 -c "from pathlib import Path; Path('/closed/planted.txt').write_text('X')"`,
        'agent',
      )
      // Read back through the unrestricted default session: the
      // confined one cannot see the mount at all.
      const [code, out] = await run(ws, 'ls /closed')
      expect(code).toBe(0)
      expect(out).not.toContain('planted.txt')
    } finally {
      await ws.close()
    }
  })

  it('a cross-mount link is not an escape hatch from confinement', async () => {
    const ws = await scopedWorld()
    try {
      expect((await run(ws, 'ln -s /closed /open/esc'))[0]).toBe(0)
      const [code, out] = await run(
        ws,
        `python3 -c "from pathlib import Path; print(Path('/open/esc/sec.txt').read_text())"`,
        'agent',
      )
      expect(code).not.toBe(0)
      expect(out).not.toContain('SECRET-xyz')
    } finally {
      await ws.close()
    }
  })
})
