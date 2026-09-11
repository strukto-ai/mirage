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
import { Runtime } from './base.ts'
import {
  bindCommands,
  buildRuntime,
  checkRuntimeOptions,
  DEFAULT_ENTRIES,
  DEFAULT_PYTHON,
  knownRuntimes,
  registerRuntime,
  runtimeBindingsFor,
  VFSRuntime,
} from './table.ts'
import { MontyRuntime } from './python/monty/index.ts'
import { PythonRuntime } from './python/base.ts'
import { PyodideRuntime } from './python/pyodide.ts'
import { QuickJsRuntime } from './js/quickjs.ts'

class FakeRuntime extends Runtime {
  readonly name = 'fake'

  constructor() {
    super({ captures: ['python3', 'made-up'] })
  }
}

describe('runtime table', () => {
  it('captures default is declared once per tier', () => {
    // The head words are a language fact like `language` itself: the
    // tier declares them, engines inherit, an instance still overrides.
    expect([...new MontyRuntime().captures]).toEqual(['python3', 'python'])
    expect([...new PyodideRuntime().captures]).toEqual(['python3', 'python'])
    expect([...new QuickJsRuntime().captures]).toEqual(['node', 'js'])
    expect([...new MontyRuntime({ captures: ['only'] }).captures]).toEqual(['only'])
  })

  it('default entries end with the vfs runtime', () => {
    expect(DEFAULT_ENTRIES[DEFAULT_ENTRIES.length - 1]).toBe('vfs')
  })

  it('the default python engine is pyodide and leads the default world', () => {
    // The one entry Python disagrees on, so it is named rather than
    // left to a slot: Python registers monty.
    expect(DEFAULT_PYTHON).toBe('pyodide')
    expect(DEFAULT_ENTRIES[0]).toBe(DEFAULT_PYTHON)
    expect(buildRuntime(DEFAULT_PYTHON)).toBeInstanceOf(PythonRuntime)
  })

  it('buildRuntime fails loud on unknown names', () => {
    expect(() => buildRuntime('ghost')).toThrow(/unknown runtime: 'ghost'/)
  })

  it('buildRuntime builds the vfs runtime by name', () => {
    expect(buildRuntime('vfs')).toBeInstanceOf(VFSRuntime)
    const restricted = buildRuntime('vfs', { captures: ['grep', 'cat'] })
    expect([...restricted.captures]).toEqual(['grep', 'cat'])
  })

  it("buildRuntime hints the right home for 'wasi' and 'local'", () => {
    expect(() => buildRuntime('wasi')).toThrow(/Python-only/)
    expect(() => buildRuntime('local')).toThrow(/mirage-node/)
  })
})

describe('bindCommands', () => {
  it('first capturer wins', () => {
    const fake = new FakeRuntime()
    const monty = new MontyRuntime()
    const bindings = bindCommands([fake, monty, new VFSRuntime()])
    expect(bindings.python3).toBe(fake)
    expect(bindings['made-up']).toBe(fake)
    expect(bindings.python).toBe(monty)
  })

  it('the vfs runtime binds nothing', () => {
    expect(bindCommands([new VFSRuntime()])).toEqual({})
  })

  it('rejects duplicate names', () => {
    expect(() => bindCommands([new FakeRuntime(), new FakeRuntime()])).toThrow(
      /duplicate runtime entry: 'fake'/,
    )
  })

  it('captures named after Object.prototype members bind like any other', () => {
    class ProtoRuntime extends Runtime {
      readonly name = 'proto'

      constructor() {
        super({ captures: ['toString', 'constructor'] })
      }
    }
    const rt = new ProtoRuntime()
    const bindings = bindCommands([rt, new VFSRuntime()])
    // A helper defeats TS resolving `.toString` to the Object method.
    const bound = (record: Record<string, Runtime>, name: string): Runtime | undefined =>
      record[name]
    expect(bound(bindings, 'toString')).toBe(rt)
    expect(bound(bindings, 'constructor')).toBe(rt)
    expect(bound(runtimeBindingsFor([rt], 'proto'), 'toString')).toBe(rt)
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

  it('every runtime takes the uniform entry keys', () => {
    expect(() => buildRuntime('pyodide', { config: { home: '/assets/pyodide' } })).not.toThrow()
    expect(() => buildRuntime('quickjs', { config: { home: '/x' } })).not.toThrow()
    expect([...buildRuntime('monty', { captures: ['python3'] }).captures]).toEqual(['python3'])
  })

  it('unknown config keys fail loud inside the runtime', () => {
    expect(() => buildRuntime('pyodide', { config: { homee: '/typo' } })).toThrow(
      /unknown runtime config key 'homee'/,
    )
    expect(() => buildRuntime('monty', { config: { home: '/x' } })).toThrow(
      /unknown runtime config key 'home'/,
    )
  })

  it('the key check stands alone, so a referenced class gets the same refusal', () => {
    expect(() => {
      checkRuntimeOptions('./box.mjs:EchoBox', { captuers: ['nvidia-smi'] })
    }).toThrow(
      /unknown \.\/box\.mjs:EchoBox runtime option 'captuers' \(expected: 'captures', 'config', 'script'\)/,
    )
    expect(() => {
      checkRuntimeOptions('./box.mjs:EchoBox', { captures: ['nvidia-smi'], config: {} })
    }).not.toThrow()
  })
})

describe('runtimeBindingsFor', () => {
  it('maps only the named runtime captures', () => {
    const fake = new FakeRuntime()
    const bindings = runtimeBindingsFor([fake, new VFSRuntime()], 'fake')
    expect(bindings).toEqual({ python3: fake, 'made-up': fake })
  })

  it('rejects the vfs name', () => {
    expect(() => runtimeBindingsFor([new FakeRuntime(), new VFSRuntime()], 'vfs')).toThrow(
      /not a runtime you can select/,
    )
  })

  it('unknown names list the workspace entries', () => {
    expect(() => runtimeBindingsFor([new FakeRuntime(), new VFSRuntime()], 'nope')).toThrow(
      /unknown runtime: 'nope' \(workspace runtimes: 'fake', 'vfs'\)/,
    )
  })
})

describe('registerRuntime', () => {
  class Other extends FakeRuntime {}

  it('makes a host class buildable by name', () => {
    registerRuntime('fake-registered', FakeRuntime)
    expect(knownRuntimes()).toContain('fake-registered')
    // FakeRuntime declares its own captures and ignores options, so the
    // table's construction path is what is under test here.
    const built = buildRuntime('fake-registered')
    expect(built).toBeInstanceOf(FakeRuntime)
    expect([...built.captures]).toEqual(['python3', 'made-up'])
  })

  it('refuses a core builtin name', () => {
    expect(() => {
      registerRuntime('monty', FakeRuntime)
    }).toThrow(/shadows a builtin/)
    expect(() => {
      registerRuntime('vfs', FakeRuntime)
    }).toThrow(/shadows a builtin/)
  })

  it('replaces a custom name', () => {
    registerRuntime('fake-replaced', FakeRuntime)
    registerRuntime('fake-replaced', Other)
    expect(buildRuntime('fake-replaced')).toBeInstanceOf(Other)
  })
})
