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
import {
  bindCommands,
  DEFAULT_ENTRIES,
  VFS_ENTRY,
  type RunArgs,
  type Runtime,
  type RunResult,
} from './runtime.ts'
import { buildRuntime, candidates } from './runtime_table.ts'
import { MontyRuntime } from './python/runtimes/monty.ts'
import { PyodideRuntime } from './python/runtimes/pyodide.ts'
import { QuickJsRuntime } from './js/quickjs.ts'

class FakeRuntime implements Runtime {
  readonly name = 'fake'
  readonly captures = ['python3', 'made-up']
  attach(): void {
    // wiring is a no-op for the fake
  }
  run(_args: RunArgs): Promise<RunResult> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 })
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

describe('runtime table', () => {
  it('candidates are ordered, derived from captures', () => {
    expect(candidates('python3')).toEqual([PyodideRuntime, MontyRuntime])
    expect(candidates('node')).toEqual([QuickJsRuntime])
    expect(candidates('grep')).toEqual([])
  })

  it('default entries end with the vfs marker', () => {
    expect(DEFAULT_ENTRIES[DEFAULT_ENTRIES.length - 1]).toBe(VFS_ENTRY)
  })

  it('buildRuntime fails loud on unknown names', () => {
    expect(() => buildRuntime('ghost')).toThrow(/unknown runtime: 'ghost'/)
  })

  it("buildRuntime hints Python-only for 'wasi' and 'local'", () => {
    expect(() => buildRuntime('wasi')).toThrow(/Python-only/)
    expect(() => buildRuntime('local')).toThrow(/Python-only/)
  })
})

describe('bindCommands', () => {
  it('first capturer wins', () => {
    const fake = new FakeRuntime()
    const monty = new MontyRuntime()
    const bindings = bindCommands([fake, monty, VFS_ENTRY])
    expect(bindings.python3).toBe(fake)
    expect(bindings['made-up']).toBe(fake)
    expect(bindings.python).toBe(monty)
  })

  it('the vfs marker binds nothing', () => {
    expect(bindCommands([VFS_ENTRY])).toEqual({})
  })

  it('rejects duplicate names', () => {
    expect(() => bindCommands([new FakeRuntime(), new FakeRuntime()])).toThrow(
      /duplicate runtime entry: 'fake'/,
    )
  })
})

describe('buildRuntime option validation', () => {
  it('rejects unknown option keys with the entry name', () => {
    expect(() => buildRuntime('pyodide', { homee: '/typo-key' })).toThrow(
      /unknown pyodide runtime option 'homee'/,
    )
    expect(() => buildRuntime('quickjs', { home: '/x' })).toThrow(
      /unknown quickjs runtime option 'home'/,
    )
  })

  it('accepts declared option keys', () => {
    expect(() => buildRuntime('pyodide', { home: '/assets/pyodide' })).not.toThrow()
  })
})
