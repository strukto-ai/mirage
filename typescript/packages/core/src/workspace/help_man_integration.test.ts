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
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  r.store.dirs.add('/')
  const registry = new OpsRegistry()
  registry.registerResource(r)
  return new Workspace(
    { '/ram/': r },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

async function makeMultiWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ram = new RAMResource()
  ram.store.dirs.add('/')
  ram.store.files.set('/a.txt', new TextEncoder().encode('a\n'))
  const other = new RAMResource()
  other.store.dirs.add('/')
  other.store.files.set('/b.txt', new TextEncoder().encode('b\n'))
  const ro = new RAMResource()
  ro.store.dirs.add('/')
  ro.store.files.set('/c.txt', new TextEncoder().encode('c\n'))
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  registry.registerResource(other)
  registry.registerResource(ro)
  return new Workspace(
    {
      '/ram/': [ram, MountMode.EXEC],
      '/other/': [other, MountMode.EXEC],
      '/ro/': [ro, MountMode.READ],
    },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

describe('--help and man through the executor', () => {
  it('--help on a builtin renders help text without invoking the handler', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cat --help')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out).toContain('Usage: cat')
    expect(out).toContain('--help')
  })

  it('--version on a builtin prints Mirage package version', async () => {
    const ws = await makeWs()
    const io = await ws.execute('tsort --version')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out).toMatch(/^tsort \(Mirage\) \d+\.\d+\.\d+\n$/)
  })

  it('--version is listed in --help for registered commands', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cat --help')
    expect(stdoutStr(io)).toContain('--version')
  })

  it('--version beats the read-only mount refusal', async () => {
    const ws = await makeMultiWs()
    const io = await ws.execute('rm --version /ro/c.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toMatch(/^rm \(Mirage\) \d+\.\d+\.\d+\n$/)
  })

  it('--help beats the read-only mount refusal', async () => {
    const ws = await makeMultiWs()
    const io = await ws.execute('rm --help /ro/c.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('Usage: rm')
  })

  it('--version beats cross-mount routing', async () => {
    const ws = await makeMultiWs()
    const io = await ws.execute('cat --version /ram/a.txt /other/b.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toMatch(/^cat \(Mirage\) \d+\.\d+\.\d+\n$/)
  })

  it('--version does not run a write command', async () => {
    const ws = await makeMultiWs()
    const io = await ws.execute('rm --version /ram/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(await ws.execute('cat /ram/a.txt'))).toBe('a\n')
  })

  it('--version after the end-of-options marker stays an operand', async () => {
    const ws = await makeMultiWs()
    const io = await ws.execute('grep -- --version /ram/a.txt')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
  })

  it('man <cmd> prints help from the existing handleMan', async () => {
    const ws = await makeWs()
    const io = await ws.execute('man cat')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out).toContain('cat')
  })

  it('man with no args lists every command grouped by resource kind', async () => {
    const ws = await makeWs()
    const io = await ws.execute('man')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out).toContain('# ram')
    expect(out).toContain('- cat')
    expect(out).toContain('- ls')
    expect(out).toContain('# general')
  })

  it('man on an unknown command exits 1', async () => {
    const ws = await makeWs()
    const io = await ws.execute('man definitely-not-a-real-command')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('no entry for')
  })

  it('workspace filePrompt mentions --help and man (with and without args)', async () => {
    const ws = await makeWs()
    const prompt = ws.filePrompt
    expect(prompt).toContain('--help')
    expect(prompt).toContain('man <cmd>')
    expect(prompt).toContain('`man`')
  })
})
