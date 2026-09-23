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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

// A glob lists what its directory holds, nested mount roots and symlinks
// included. Pinned against GNU coreutils 9.7 on debian:stable-slim with a
// tmpfs at base/inner and the same symlink:
//   echo base/*   -> base/f1 base/inner base/link base/sub
//   du -b base/*  -> 3 base/f1 / 7 base/inner / <target len> base/link / 7 base/sub

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const root = new RAMVFS()
  const inner = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(root)
  registry.registerVfs(inner)
  const ws = new Workspace(
    { '/': root, '/base/inner': inner },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  ws.createSession('s')
  await ws.shell('mkdir -p /base/sub', { sessionId: 's' })
  await ws.shell('printf 111 > /base/f1', { sessionId: 's' })
  await ws.shell('printf 2222222 > /base/sub/f2', { sessionId: 's' })
  await ws.shell('printf 3333333 > /base/inner/g1', { sessionId: 's' })
  await ws.shell('ln -s /base/sub/f2 /base/link', { sessionId: 's' })
  return ws
}

async function out(ws: Workspace, line: string): Promise<string> {
  return stdoutStr(await ws.shell(line, { sessionId: 's' }))
}

describe('glob expansion sees namespace state', () => {
  it('enumerates a nested mount root and a symlink', async () => {
    const ws = await makeWs()
    expect((await out(ws, 'echo /base/*')).split(/\s+/).filter(Boolean)).toEqual([
      '/base/f1',
      '/base/inner',
      '/base/link',
      '/base/sub',
    ])
  })

  it('du rows match GNU', async () => {
    const ws = await makeWs()
    expect((await out(ws, 'du /base/*')).trimEnd().split('\n')).toEqual([
      '3\t/base/f1',
      '7\t/base/inner',
      '12\t/base/link',
      '7\t/base/sub',
    ])
  })

  it('every glob-operand command sees them', async () => {
    const ws = await makeWs()
    expect((await out(ws, 'ls -d /base/*')).split(/\s+/).filter(Boolean)).toEqual([
      '/base/f1',
      '/base/inner',
      '/base/link',
      '/base/sub',
    ])
    expect((await out(ws, 'find /base/* -maxdepth 0')).split(/\s+/).filter(Boolean)).toEqual([
      '/base/f1',
      '/base/inner',
      '/base/link',
      '/base/sub',
    ])
  })

  it('matches only the pattern', async () => {
    const ws = await makeWs()
    expect((await out(ws, 'echo /base/i*')).trim()).toBe('/base/inner')
    expect((await out(ws, 'echo /base/l*')).trim()).toBe('/base/link')
    expect((await out(ws, 'echo /base/f*')).trim()).toBe('/base/f1')
  })

  // GNU bash 5.2 (debian:stable-slim), `*a.txt` beside `xa.txt`:
  //   echo /data/*a.txt -> /data/*a.txt /data/xa.txt
  // The live `*` matches the literal `*` in the first name.
  it('keeps a match spelled like the glob word', async () => {
    const ws = await makeWs()
    await ws.shell("touch '/base/*a.txt'", { sessionId: 's' })
    await ws.shell('touch /base/xa.txt', { sessionId: 's' })
    expect((await out(ws, 'echo /base/*a.txt')).split(/\s+/).filter(Boolean)).toEqual([
      '/base/*a.txt',
      '/base/xa.txt',
    ])
  })

  // A quoted glob character in the parent is part of a real name. The
  // backend is asked with the directory-shaped spec, and a match is a real
  // path it listed, so the two are compared in unmarked space; the marked
  // spelling names no directory and would answer every word under
  // `'/base/*d'/` with the literal. GNU bash 5.2 (debian:stable-slim):
  //   echo '/data/*d'/*.txt -> /data/*d/one.txt /data/*d/two.txt
  it('lists a directory whose name holds a quoted glob character', async () => {
    const ws = await makeWs()
    await ws.shell("mkdir '/base/*d'", { sessionId: 's' })
    await ws.shell("touch '/base/*d/one.txt'", { sessionId: 's' })
    await ws.shell("touch '/base/*d/two.txt'", { sessionId: 's' })
    expect((await out(ws, "echo '/base/*d'/*.txt")).split(/\s+/).filter(Boolean)).toEqual([
      '/base/*d/one.txt',
      '/base/*d/two.txt',
    ])
    expect((await out(ws, "echo '/base/*d'/o*.txt")).trim()).toBe('/base/*d/one.txt')
    // Nothing under it still falls back to the literal word.
    expect((await out(ws, "echo '/base/*d'/*.none")).trim()).toBe('/base/*d/*.none')
  })

  it('keeps an unmatched glob literal', async () => {
    const ws = await makeWs()
    expect((await out(ws, 'echo /base/zzz*')).trim()).toBe('/base/zzz*')
  })

  it('descends into a nested mount mid-path', async () => {
    const ws = await makeWs()
    expect((await out(ws, 'echo /base/*/g1')).trim()).toBe('/base/inner/g1')
  })

  // A glob matching exactly one name is still an expansion. Comparing
  // counts read it as unchanged, so the pattern stayed routed to the
  // parent mount, which cannot serve the child mount's keys.
  it('installs a boundary glob that matches one name', async () => {
    const ws = await makeWs()
    expect((await out(ws, 'du /base/i*')).trimEnd()).toBe('7\t/base/inner')
    expect((await out(ws, 'ls -d /base/i*')).trim()).toBe('/base/inner')
  })

  // The mount-root refusal reads the operands, so an expansion that
  // happens after the admission policies hands tar a mount root nobody
  // checked. Both spellings must answer identically.
  it('refuses a mount root a glob produced', async () => {
    const ws = await makeWs()
    const typed = await ws.shell('tar -cf /out.tar /base/inner', { sessionId: 's' })
    const globbed = await ws.shell('tar -cf /out2.tar /base/i*', { sessionId: 's' })
    expect(new TextDecoder().decode(globbed.stderr)).toBe(new TextDecoder().decode(typed.stderr))
    expect(globbed.exitCode).toBe(typed.exitCode)
    expect(new TextDecoder().decode(globbed.stderr)).toContain('Device or resource busy')
  })
})

// bash descends through a symlinked directory during pathname expansion
// and reports the match under the typed name. Pinned against GNU bash
// 5.2 on debian:stable-slim with base/dlink -> base/sub:
//   echo base/d*/f2 -> base/dlink/f2
//   echo base/*/f2  -> base/dlink/f2 base/sub/f2
describe('glob expansion follows a symlinked directory', () => {
  async function makeLinked(): Promise<Workspace> {
    const ws = await makeWs()
    await ws.shell('ln -s /base/sub /base/dlink', { sessionId: 's' })
    await ws.shell('ln -s /base/inner /base/mlink', { sessionId: 's' })
    return ws
  }

  it('descends a link in a mid-path segment', async () => {
    const ws = await makeLinked()
    expect((await out(ws, 'echo /base/d*/f2')).trim()).toBe('/base/dlink/f2')
  })

  it('lists a link named as the final parent', async () => {
    const ws = await makeLinked()
    expect((await out(ws, 'echo /base/dlink/*')).trim()).toBe('/base/dlink/f2')
  })

  it('reports both the link and its target', async () => {
    const ws = await makeLinked()
    expect((await out(ws, 'echo /base/*/f2')).split(/\s+/).filter(Boolean)).toEqual([
      '/base/dlink/f2',
      '/base/sub/f2',
    ])
  })

  it('follows a link that points into a nested mount', async () => {
    const ws = await makeLinked()
    expect((await out(ws, 'echo /base/mlink/*')).trim()).toBe('/base/mlink/g1')
    expect((await out(ws, 'echo /base/m*/g1')).trim()).toBe('/base/mlink/g1')
  })
})

// Trailing-slash pathname expansion, pinned against bash 5.2.37
// (debian:stable-slim) and bash 3.2.57: a word ending in a slash matches
// directories only (a symlink to a directory counts, a broken link and a
// regular file do not), and every match keeps exactly one trailing slash
// (#1065).
async function makeDirsWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const root = new RAMVFS()
  const inner = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(root)
  registry.registerVfs(inner)
  const ws = new Workspace(
    { '/': root, '/data/records/inner': inner },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  ws.createSession('s')
  await ws.shell('mkdir -p /data/records/2026-09-10 /data/records/2026-09-11', { sessionId: 's' })
  await ws.shell('echo sample > /data/records/2026-09-10/sample.txt', { sessionId: 's' })
  await ws.shell('echo plain > /data/records/plain.txt', { sessionId: 's' })
  await ws.shell('ln -s /data/records/2026-09-10 /data/records/lnk', { sessionId: 's' })
  await ws.shell('ln -s /data/records/nowhere /data/records/broken', { sessionId: 's' })
  return ws
}

// One mount and no boundary under the globbed directory, so a mount
// command's pattern travels to the command tier instead of being resolved
// by the shell tier on the way (which is what a nested mount forces).
async function makeFlatWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const registry = new OpsRegistry()
  const data = new RAMVFS()
  registry.registerVfs(data)
  const ws = new Workspace(
    { '/data': data },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  ws.createSession('s')
  await ws.shell('mkdir -p /data/records/2026-09-10 /data/records/2026-09-11', { sessionId: 's' })
  await ws.shell('echo sample > /data/records/2026-09-10/sample.txt', { sessionId: 's' })
  await ws.shell('echo plain > /data/records/plain.txt', { sessionId: 's' })
  await ws.shell('ln -s /data/records/2026-09-10 /data/records/lnk', { sessionId: 's' })
  await ws.shell('ln -s /data/records/nowhere /data/records/broken', { sessionId: 's' })
  return ws
}

describe('trailing-slash globs', () => {
  it('keeps the slash and matches directories only', async () => {
    const ws = await makeDirsWs()
    expect(await out(ws, "cd /data/records && printf '<%s>\\n' */")).toBe(
      '<2026-09-10/>\n<2026-09-11/>\n<inner/>\n<lnk/>\n',
    )
  })

  it('spells an absolute word', async () => {
    const ws = await makeDirsWs()
    expect(await out(ws, "printf '<%s>\\n' /data/records/2026*/")).toBe(
      '</data/records/2026-09-10/>\n</data/records/2026-09-11/>\n',
    )
  })

  it('spells a relative head', async () => {
    const ws = await makeDirsWs()
    expect(await out(ws, "cd /data && printf '<%s>\\n' records/2026*/")).toBe(
      '<records/2026-09-10/>\n<records/2026-09-11/>\n',
    )
  })

  it('walks a mid-path pattern', async () => {
    const ws = await makeDirsWs()
    expect(await out(ws, "cd /data && printf '<%s>\\n' */2026*/")).toBe(
      '<records/2026-09-10/>\n<records/2026-09-11/>\n',
    )
  })

  it('keeps a zero-match word literal', async () => {
    const ws = await makeDirsWs()
    expect(await out(ws, "cd /data/records && printf '<%s>\\n' nomatch*/")).toBe('<nomatch*/>\n')
  })

  // A mount command's pattern reaches the command tier, which resolves it
  // with the namespace in view: the nested mount root and the link to a
  // directory are kept, the file and the dangling link are dropped.
  it('reaches a command operand with the namespace in view', async () => {
    const ws = await makeFlatWs()
    expect(await out(ws, 'cd /data/records && ls -d */')).toBe('2026-09-10/\n2026-09-11/\nlnk/\n')
  })

  it('keeps each spelling of one directory on its own row', async () => {
    const ws = await makeFlatWs()
    expect(await out(ws, 'cd /data/records && ls -d 2026-09-10/ lnk/')).toBe('2026-09-10/\nlnk/\n')
  })

  // The builders that walked without resolving leaned on the dispatcher's
  // expansion; they resolve for themselves now, like their python twins.
  it('expands a pattern for cp, mv, readlink and realpath', async () => {
    const ws = await makeFlatWs()
    expect(await out(ws, 'cd /data/records && mkdir out && cp 2026-*/*.txt out && ls out')).toBe(
      'sample.txt\n',
    )
    expect(await out(ws, 'cd /data/records && mv out/samp* moved.txt && ls moved.txt')).toBe(
      'moved.txt\n',
    )
    expect(await out(ws, 'cd /data/records && readlink ln*')).toBe('/data/records/2026-09-10\n')
    expect(await out(ws, 'cd /data/records && realpath 2026*')).toBe(
      '/data/records/2026-09-10\n/data/records/2026-09-11\n',
    )
  })

  it('keeps one slash for a doubled one', async () => {
    const ws = await makeDirsWs()
    expect(await out(ws, "cd /data/records && printf '<%s>\\n' 2026*//")).toBe(
      '<2026-09-10/>\n<2026-09-11/>\n',
    )
  })

  it('drives the traversal loop from the issue', async () => {
    // `"$d"*.txt` concatenates the spelled directory, so a missing slash
    // made every file invisible.
    const ws = await makeDirsWs()
    const line =
      'cd /data/records && for d in */; do for f in "$d"*.txt; do [ -f "$f" ] || continue; cat "$f"; done; done'
    expect(await out(ws, line)).toBe('sample\nsample\n')
  })
})
