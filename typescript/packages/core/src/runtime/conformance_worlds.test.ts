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
import { FileType, MountMode } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { MontyRuntime } from './python/monty/index.ts'

// One world, three surfaces, one door: the TS half of the conformance
// worlds (python/tests/runtime/test_conformance_worlds.py). The suite
// pins the facts a mount tree must present identically through the
// shell (virtual commands) and a sandboxed guest (its own stdlib); the
// FUSE surface lives in @struktoai/mirage-node, whose core routes every
// op through the same Workspace.dispatch these tests exercise.
//
// R1 (mount structure into the door: readdir/stat merge child mounts
// and namespace links behind the session guard, fan-out and the ls
// fact session-filtered) has landed, which is why the structure and
// enumeration groups run unmarked. Facts still broken run as it.fails
// with the reason beside them, and start passing loud when fixed.

async function structureWorld(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const base = new RAMResource()
  const inner = new RAMResource()
  ops.registerResource(base)
  ops.registerResource(inner)
  const ws = new Workspace(
    {},
    { mode: MountMode.EXEC, ops, shellParser: parser, runtimes: [new MontyRuntime(), 'vfs'] },
  )
  ws.addMount('/base', base, MountMode.WRITE)
  ws.addMount('/base/inner', inner, MountMode.WRITE)
  // Seeded through the fs facade, not the shell: a shell line would be
  // recorded into /.bash_history, which every session may read, and the
  // scoped-world tests would then find the seed line instead of a leak.
  await ws.fs.writeFile('/base/a.txt', 'top')
  await ws.fs.writeFile('/base/inner/deep.txt', 'needle')
  return ws
}

async function scopedWorld(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const open = new RAMResource()
  const closed = new RAMResource()
  ops.registerResource(open)
  ops.registerResource(closed)
  const ws = new Workspace(
    {},
    { mode: MountMode.EXEC, ops, shellParser: parser, runtimes: [new MontyRuntime(), 'vfs'] },
  )
  ws.addMount('/open', open, MountMode.WRITE)
  ws.addMount('/closed', closed, MountMode.WRITE)
  await ws.fs.writeFile('/open/pub.txt', 'public')
  await ws.fs.writeFile('/closed/sec.txt', 'SECRET-xyz')
  ws.createSession('agent', { mounts: ['/open'] })
  return ws
}

async function run(
  ws: Workspace,
  line: string,
  sessionId?: string,
): Promise<[number, string, string]> {
  const io = await ws.execute(line, sessionId !== undefined ? { sessionId } : undefined)
  return [io.exitCode, stdoutStr(io), stderrStr(io)]
}

// ts monty's iterdir yields plain strings where py monty yields Path
// objects; `str(p)` reads the entry either way.
const LIST_BASE = `python3 -c "from pathlib import Path; print(sorted(str(p) for p in Path('/base').iterdir()))"`

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

  it('guest lists the child mount', async () => {
    const ws = await structureWorld()
    try {
      const [code, out, err] = await run(ws, LIST_BASE)
      expect(code, err).toBe(0)
      expect(out).toContain('inner')
    } finally {
      await ws.close()
    }
  })

  it('guest lists the namespace link', async () => {
    const ws = await structureWorld()
    try {
      expect((await run(ws, 'ln -s /base/inner /base/lnk'))[0]).toBe(0)
      const [code, out, err] = await run(ws, LIST_BASE)
      expect(code, err).toBe(0)
      expect(out).toContain('lnk')
    } finally {
      await ws.close()
    }
  })

  it('guest reads through a link by exact path', async () => {
    const ws = await structureWorld()
    try {
      expect((await run(ws, 'ln -s /base/inner /base/lnk'))[0]).toBe(0)
      const [code, out, err] = await run(
        ws,
        `python3 -c "from pathlib import Path; print(Path('/base/lnk/deep.txt').read_text())"`,
      )
      expect(code, err).toBe(0)
      expect(out).toContain('needle')
    } finally {
      await ws.close()
    }
  })

  it('link ancestors synthesize on every surface', async () => {
    // ln permits /ghost/deep/lnk with no backend serving /ghost; its
    // ancestors synthesize exactly as nested mount prefixes do, so
    // `ls /` shows the way in and a guest walk from the root reaches
    // the link.
    const ws = await structureWorld()
    try {
      expect((await run(ws, 'ln -s /base/a.txt /ghost/deep/lnk'))[0]).toBe(0)
      const stat = await ws.stat('/ghost')
      expect((stat as { type: FileType | null }).type).toBe(FileType.DIRECTORY)
      const [code, out] = await run(ws, 'ls /')
      expect(code).toBe(0)
      expect(out).toContain('ghost')
      // No guest probe here: a ts guest serves only paths under a
      // visible mount, and /ghost (like / itself) is not one — the
      // documented root-anchor divergence from python, whose guests
      // fall through to dispatch and do walk the synthesized chain.
    } finally {
      await ws.close()
    }
  })

  // ── Group 2: a structure-only directory stats as a directory ──

  it('the door stats a structure-only directory', async () => {
    const ws = await structureWorld()
    try {
      const stat = await ws.stat('/base/inner')
      expect((stat as { type: FileType | null }).type).toBe(FileType.DIRECTORY)
      const [code, out, err] = await run(
        ws,
        `python3 -c "from pathlib import Path; print(Path('/base/inner').is_dir())"`,
      )
      expect(code, err).toBe(0)
      expect(out).toContain('True')
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
  ])('an explicit operand at the boundary is denied: %s', async (line) => {
    const ws = await scopedWorld()
    try {
      const [code, , err] = await run(ws, line, 'agent')
      expect(code).not.toBe(0)
      expect(err).toContain('not allowed')
      expect(err).toContain('/closed')
    } finally {
      await ws.close()
    }
  })

  it('a scoped session cannot learn an ungranted name from the root listing', async () => {
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

  it('a link below an ungranted mount stays out of a scoped listing', async () => {
    // The link's path discloses the same name childMountNames already
    // filters, so the same grant filters it; the unrestricted view
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

  it('a confined guest cannot read an ungranted mount', async () => {
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

  it('a confined guest cannot write an ungranted mount', async () => {
    const ws = await scopedWorld()
    try {
      await run(
        ws,
        `python3 -c "from pathlib import Path; Path('/closed/planted.txt').write_text('X')"`,
        'agent',
      )
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
