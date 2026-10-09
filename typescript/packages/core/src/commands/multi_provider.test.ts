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
import { compileSpec } from './spec/compile.ts'
import { invoke } from '../io/stdio.ts'
import { describe, expect, it } from 'vitest'
import { command, Command } from './config.ts'
import { CommandSpec } from './spec/types.ts'
import { IOResult, materialize } from '../io/types.ts'

const noopFn = (): Promise<[Uint8Array, IOResult]> =>
  Promise.resolve([new Uint8Array(), new IOResult()])

describe('command() registers multiple mounts', () => {
  it('returns one Command per VFS when passed an array', () => {
    const cmds = command({
      name: 'cat',
      vfs: ['gdocs', 'gdrive'],
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(2)
    const mounts = cmds.map((c) => c.vfs)
    expect(mounts).toContain('gdocs')
    expect(mounts).toContain('gdrive')
    for (const c of cmds) {
      expect(c).toBeInstanceOf(Command)
      expect(c.name).toBe('cat')
    }
  })

  it('single-VFS string still produces one Command', () => {
    const cmds = command({
      name: 'ls',
      vfs: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(1)
    const first = cmds[0]
    expect(first).toBeDefined()
    expect(first?.vfs).toBe('disk')
  })

  it('null VFS produces a general-registered command', () => {
    const cmds = command({
      name: 'echo',
      vfs: null,
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(1)
    expect(cmds[0]?.vfs).toBeNull()
  })

  it('auto-injects --help into spec.options', () => {
    const cmds = command({
      name: 'foo',
      vfs: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    const first = cmds[0]
    if (first === undefined) throw new Error('missing registered command')
    const helpOpt = compileSpec(first.spec).options.find((o) => o.names.includes('--help'))
    expect(helpOpt).toBeDefined()
  })

  it('--help short-circuits the handler and returns rendered help', async () => {
    let handlerCalled = false
    const cmds = command({
      name: 'bar',
      vfs: 'disk',
      spec: new CommandSpec({ description: 'do bar' }),
      fn: () => {
        handlerCalled = true
        return Promise.resolve([new Uint8Array(), new IOResult()])
      },
    })
    const opts = {
      stdin: null,
      flags: { help: true },
      cwd: '/',
      vfs: {} as never,
    }
    const cmd = cmds[0]
    if (cmd === undefined) throw new Error('expected a registered command')
    const result = await invoke(() => cmd.fn({} as never, [], [], opts))
    expect(handlerCalled).toBe(false)
    const stdout = result?.[0]
    expect(stdout).toBeDefined()
    const text = new TextDecoder().decode(await materialize(stdout ?? null))
    expect(text).toContain('bar: do bar')
    expect(text).toContain('--help')
  })

  it('auto-injects --version into spec.options', () => {
    const cmds = command({
      name: 'foo',
      vfs: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    const first = cmds[0]
    if (first === undefined) throw new Error('missing registered command')
    const versionOpt = compileSpec(first.spec).options.find((o) => o.names.includes('--version'))
    expect(versionOpt).toBeDefined()
  })

  it('--version short-circuits the handler and returns package version', async () => {
    let handlerCalled = false
    const cmds = command({
      name: 'tsort',
      vfs: 'disk',
      spec: new CommandSpec(),
      fn: () => {
        handlerCalled = true
        return Promise.resolve([new Uint8Array(), new IOResult()])
      },
    })
    const opts = {
      stdin: null,
      flags: { version: true },
      cwd: '/',
      vfs: {} as never,
    }
    const cmd = cmds[0]
    if (cmd === undefined) throw new Error('expected a registered command')
    const result = await invoke(() => cmd.fn({} as never, [], [], opts))
    expect(handlerCalled).toBe(false)
    const stdout = result?.[0]
    expect(stdout).toBeDefined()
    const text = new TextDecoder().decode(await materialize(stdout ?? null))
    expect(text).toMatch(/^tsort \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })
})
