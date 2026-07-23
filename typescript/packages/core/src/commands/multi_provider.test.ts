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
import { command, RegisteredCommand, versionRequest } from './config.ts'
import { CommandSpec, Option } from './spec/types.ts'
import { IOResult } from '../io/types.ts'

const noopFn = (): Promise<[Uint8Array, IOResult]> =>
  Promise.resolve([new Uint8Array(), new IOResult()])

function specFor(name: string, spec = new CommandSpec()): CommandSpec | null {
  return command({ name, resource: 'disk', spec, fn: noopFn })[0]?.spec ?? null
}

function decode(out: Uint8Array | null): string | null {
  return out === null ? null : new TextDecoder().decode(out)
}

describe('command() registers multiple resources', () => {
  it('returns one RegisteredCommand per resource when passed an array', () => {
    const cmds = command({
      name: 'cat',
      resource: ['gdocs', 'gdrive'],
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(2)
    const resources = cmds.map((c) => c.resource)
    expect(resources).toContain('gdocs')
    expect(resources).toContain('gdrive')
    for (const c of cmds) {
      expect(c).toBeInstanceOf(RegisteredCommand)
      expect(c.name).toBe('cat')
    }
  })

  it('single-resource string still produces one RegisteredCommand', () => {
    const cmds = command({
      name: 'ls',
      resource: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(1)
    const first = cmds[0]
    expect(first).toBeDefined()
    expect(first?.resource).toBe('disk')
  })

  it('null resource produces a general-registered command', () => {
    const cmds = command({
      name: 'echo',
      resource: null,
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(1)
    expect(cmds[0]?.resource).toBeNull()
  })

  it('auto-injects --help into spec.options', () => {
    const cmds = command({
      name: 'foo',
      resource: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    const helpOpt = cmds[0]?.spec.options.find((o) => o.long === '--help')
    expect(helpOpt).toBeDefined()
  })

  it('--help short-circuits the handler and returns rendered help', async () => {
    let handlerCalled = false
    const cmds = command({
      name: 'bar',
      resource: 'disk',
      spec: new CommandSpec({ description: 'do bar' }),
      fn: () => {
        handlerCalled = true
        return Promise.resolve([new Uint8Array(), new IOResult()])
      },
    })
    const opts = {
      stdin: null,
      flags: { help: true },
      filetypeFns: null,
      cwd: '/',
      resource: {} as never,
    }
    const result = await cmds[0]?.fn({} as never, [], [], opts)
    expect(handlerCalled).toBe(false)
    const stdout = result?.[0]
    expect(stdout).toBeDefined()
    const text = new TextDecoder().decode(stdout as Uint8Array)
    expect(text).toContain('bar: do bar')
    expect(text).toContain('--help')
  })

  it('auto-injects --version into spec.options', () => {
    const cmds = command({
      name: 'foo',
      resource: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    const versionOpt = cmds[0]?.spec.options.find((o) => o.long === '--version')
    expect(versionOpt).toBeDefined()
  })

  it('--version short-circuits the handler and returns package version', async () => {
    let handlerCalled = false
    const cmds = command({
      name: 'tsort',
      resource: 'disk',
      spec: new CommandSpec(),
      fn: () => {
        handlerCalled = true
        return Promise.resolve([new Uint8Array(), new IOResult()])
      },
    })
    const opts = {
      stdin: null,
      flags: { version: true },
      filetypeFns: null,
      cwd: '/',
      resource: {} as never,
    }
    const result = await cmds[0]?.fn({} as never, [], [], opts)
    expect(handlerCalled).toBe(false)
    const stdout = result?.[0]
    expect(stdout).toBeDefined()
    const text = new TextDecoder().decode(stdout as Uint8Array)
    expect(text).toMatch(/^tsort \(Mirage\) \d+\.\d+\.\d+\n$/)
  })
})

describe('versionRequest', () => {
  it('matches the injected option', () => {
    const out = versionRequest('tsort', specFor('tsort'), ['--version'])
    expect(decode(out)).toMatch(/^tsort \(Mirage\) \d+\.\d+\.\d+\n$/)
  })

  it('is null without the flag', () => {
    expect(versionRequest('tsort', specFor('tsort'), ['/data/a.txt'])).toBeNull()
  })

  it('is null after the end-of-options marker', () => {
    expect(versionRequest('grep', specFor('grep'), ['--', '--version'])).toBeNull()
  })

  it('is null for an unregistered command', () => {
    expect(versionRequest('nope', null, ['--version'])).toBeNull()
  })

  it('is null when the command declares its own --version', () => {
    const own = new CommandSpec({ options: [new Option({ long: '--version' })] })
    expect(versionRequest('custom', specFor('custom', own), ['--version'])).toBeNull()
  })
})
