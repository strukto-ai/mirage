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
import { getTestParser, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace.ts'

// A glob lists what its directory holds, nested mount roots and symlinks
// included. Pinned against GNU coreutils 9.7 on debian:stable-slim with a
// tmpfs at base/inner and the same symlink:
//   echo base/*   -> base/f1 base/inner base/link base/sub
//   du -b base/*  -> 3 base/f1 / 7 base/inner / <target len> base/link / 7 base/sub

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const root = new RAMResource()
  const inner = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(root)
  registry.registerResource(inner)
  const ws = new Workspace(
    { '/': root, '/base/inner': inner },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  ws.createSession('s')
  await ws.execute('mkdir -p /base/sub', { sessionId: 's' })
  await ws.execute('printf 111 > /base/f1', { sessionId: 's' })
  await ws.execute('printf 2222222 > /base/sub/f2', { sessionId: 's' })
  await ws.execute('printf 3333333 > /base/inner/g1', { sessionId: 's' })
  await ws.execute('ln -s /base/sub/f2 /base/link', { sessionId: 's' })
  return ws
}

async function out(ws: Workspace, line: string): Promise<string> {
  return stdoutStr(await ws.execute(line, { sessionId: 's' }))
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
    const typed = await ws.execute('tar -cf /out.tar /base/inner', { sessionId: 's' })
    const globbed = await ws.execute('tar -cf /out2.tar /base/i*', { sessionId: 's' })
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
    await ws.execute('ln -s /base/sub /base/dlink', { sessionId: 's' })
    await ws.execute('ln -s /base/inner /base/mlink', { sessionId: 's' })
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
