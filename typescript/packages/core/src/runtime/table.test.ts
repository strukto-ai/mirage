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
import { JsRuntime } from './js/base.ts'
import { LanguageRuntime } from './language.ts'
import { PROCESS_EXECUTOR, type ProcessExecutorMixin } from './mixin.ts'
import { PythonRuntime } from './python/base.ts'
import type { Language, RunResult } from './types.ts'
import {
  bindCommands,
  buildEntry,
  buildRuntime,
  builtFrom,
  knownRuntimes,
  machineBindingsFor,
  placement,
  registerRuntime,
  shadowedCaptures,
} from './table.ts'
import { WorkspaceRuntime } from './workspace.ts'
import { RemoteRuntime } from './machine/runtime.ts'
import { MontyRuntime } from './python/monty/index.ts'
import { PyodideRuntime } from './python/pyodide/runtime.ts'
import { QuickJsRuntime } from './js/quickjs/runtime.ts'

class FakeRuntime extends Runtime {
  readonly name = 'fake'

  constructor() {
    super({ captures: ['python3', 'made-up'] })
  }
}

const done = (): Promise<RunResult> =>
  Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })

class PyEngine extends PythonRuntime {
  readonly name = 'pyengine'

  constructor(captures?: string[]) {
    super(captures !== undefined ? { captures } : {})
  }

  interpret = done
}

class JsEngine extends JsRuntime {
  readonly name = 'jsengine'

  constructor(captures?: string[]) {
    super(captures !== undefined ? { captures } : {})
  }

  interpret = done
}

class HostPython extends PythonRuntime implements ProcessExecutorMixin {
  readonly [PROCESS_EXECUTOR] = true as const
  readonly name = 'host-python'

  constructor(captures: string[]) {
    super({ captures })
  }

  interpret = done
  runProcess = done
}

// A language runtime that sets no head words, as a custom one may.
class DirectEngine extends LanguageRuntime {
  readonly name = 'direct'
  readonly language: Language = 'python'

  constructor() {
    super({}, ['python3', 'python'])
  }

  interpret = done
}

class Cap extends Runtime {
  readonly name = 'cap'

  constructor(captures: string[]) {
    super({ captures })
  }
}

// A runtime capturing one name, for the groups a capture may spell.
class OneCapture extends Runtime {
  readonly name = 'one'

  constructor(capture: string) {
    super({ captures: [capture] })
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

  it('buildRuntime builds pyodide by name', () => {
    expect(buildRuntime('pyodide')).toBeInstanceOf(PyodideRuntime)
  })

  it.each<[string, RegExp]>([
    ['ghost', /unknown runtime: 'ghost'/],
    ['nope', /unknown runtime/],
    ['wasi', /Python-only/],
    ['local', /mirage-node/],
  ])('buildRuntime refuses %s, naming why', (name, refusal) => {
    expect(() => buildRuntime(name)).toThrow(refusal)
  })

  it('buildRuntime builds the workspace runtime by name', () => {
    expect(buildRuntime('workspace')).toBeInstanceOf(WorkspaceRuntime)
    const restricted = buildRuntime('workspace', { captures: ['grep', 'cat'] })
    expect([...restricted.captures]).toEqual(['grep', 'cat'])
  })
})

describe('bindCommands', () => {
  it('first capturer wins', () => {
    const fake = new FakeRuntime()
    const monty = new MontyRuntime()
    const bindings = bindCommands([fake, monty, new WorkspaceRuntime()])
    expect(bindings.python3).toBe(fake)
    expect(bindings['made-up']).toBe(fake)
    expect(bindings.python).toBe(monty)
  })

  it('the workspace runtime binds nothing', () => {
    expect(bindCommands([new WorkspaceRuntime()])).toEqual({})
  })

  // Twin of test_bind_commands_refuses_a_group_it_does_not_have.
  it.each(['*', '@all', '@lines', '@pyton'])('refuses a group it does not have: %s', (capture) => {
    expect(() => bindCommands([new OneCapture(capture)])).toThrow(
      `'${capture}' is not a program or a group; the groups are '@external', '@line', '@python' and '@js'`,
    )
  })

  // Twin of test_bind_commands_refuses_a_capture_a_language_runtime_does_not_run.
  it.each([
    [() => new PyEngine(['node']), 'pyengine', 'node'],
    [() => new PyEngine(['gcc']), 'pyengine', 'gcc'],
    [() => new JsEngine(['python3']), 'jsengine', 'python3'],
    [() => new PyEngine(['@js']), 'pyengine', 'node'],
  ] as const)('refuses a capture a language runtime does not run: %#', (make, name, capture) => {
    expect(() => bindCommands([make()])).toThrow(`machine '${name}' does not run '${capture}'`)
  })

  // Twin of test_bind_commands_lets_a_language_runtime_that_runs_processes_take_any_name.
  it('lets a language runtime that runs processes take any name', () => {
    const host = new HostPython(['python3', 'node'])
    expect(bindCommands([host])).toEqual({ python3: host, node: host })
  })

  // Twin of test_bind_commands_reads_the_tier_from_the_language_not_from_commands.
  it('reads the tier from the language, not from commands', () => {
    const direct = new DirectEngine()
    expect(bindCommands([direct])).toEqual({ python3: direct, python: direct })
  })

  // Twin of test_a_group_expands_to_the_interpreter_names_mirage_owns.
  it('a group expands to the interpreter names Mirage owns', () => {
    expect(new PyEngine(['@python']).captures).toEqual(['python3', 'python'])
    expect(new JsEngine(['@js']).captures).toEqual(['node', 'js'])
    expect(new Cap(['@python', 'pip', 'python3', '@external']).captures).toEqual([
      'python3',
      'python',
      'pip',
      '@external',
    ])
  })

  // Twin of test_an_explicit_empty_list_captures_nothing.
  it('an explicit empty list captures nothing', () => {
    expect(new PyEngine([]).captures).toEqual([])
  })

  // Twin of test_a_group_in_a_class_default_expands_too.
  it('a group in a default expands too', () => {
    class GroupDefault extends Runtime {
      readonly name = 'group-default'

      constructor() {
        super({}, ['@python', 'pip'])
      }
    }
    expect(new GroupDefault().captures).toEqual(['python3', 'python', 'pip'])
  })

  // Twin of test_a_group_binds_both_names_to_the_runtime_that_took_it.
  it('a group binds both names to the runtime that took it', () => {
    const fake = new Cap(['@python', 'pip'])
    const bindings = bindCommands([fake, new PyEngine()])
    expect([bindings.python3, bindings.python, bindings.pip]).toEqual([fake, fake, fake])
  })

  it('rejects duplicate names', () => {
    expect(() => bindCommands([new FakeRuntime(), new FakeRuntime()])).toThrow(
      /duplicate machine: 'fake'/,
    )
  })

  it('takes a remote runtime per machine', () => {
    const a = new RemoteRuntime('a')
    const b = new RemoteRuntime('b', { captures: ['node'] })
    expect([a.name, b.name]).toEqual(['a', 'b'])
    const bindings = bindCommands([a, b])
    expect(bindings['@external']).toBe(a)
    expect(bindings.node).toBe(b)
    expect(() => bindCommands([a, new RemoteRuntime('a', { captures: ['node'] })])).toThrow(
      /duplicate machine: 'a'/,
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
    const bindings = bindCommands([rt, new WorkspaceRuntime()])
    // A helper defeats TS resolving `.toString` to the Object method.
    const bound = (record: Record<string, Runtime>, name: string): Runtime | undefined =>
      record[name]
    expect(bound(bindings, 'toString')).toBe(rt)
    expect(bound(bindings, 'constructor')).toBe(rt)
    expect(bound(machineBindingsFor([rt], 'proto'), 'toString')).toBe(rt)
  })
})

describe('buildRuntime options', () => {
  it('every runtime takes the uniform options', () => {
    expect(() => buildRuntime('pyodide', { config: { home: '/assets/pyodide' } })).not.toThrow()
    expect(() => buildRuntime('quickjs', { config: { home: '/x' } })).not.toThrow()
    expect([...buildRuntime('monty', { captures: ['python3'] }).captures]).toEqual(['python3'])
  })

  it('unknown options fail loud', () => {
    expect(() => buildRuntime('monty', { captuers: [] })).toThrow(
      /unknown monty runtime option 'captuers' \(expected: 'captures', 'config'\)/,
    )
  })

  it('unknown config keys fail loud inside the runtime', () => {
    expect(() => buildRuntime('pyodide', { config: { homee: '/typo' } })).toThrow(
      /unknown runtime config key 'homee'/,
    )
    expect(() => buildRuntime('monty', { config: { home: '/x' } })).toThrow(
      /unknown runtime config key 'home'/,
    )
  })
})

describe('machineBindingsFor', () => {
  it('maps only the named captures', () => {
    const fake = new FakeRuntime()
    const bindings = machineBindingsFor([fake, new WorkspaceRuntime()], 'fake')
    expect(bindings).toEqual({ python3: fake, 'made-up': fake })
  })

  it.each<[string, RegExp]>([
    ['workspace', /not a machine you can select/],
    ['nope', /unknown machine: 'nope' \(workspace machines: 'fake'\)/],
  ])('refuses %s, naming why', (name, refusal) => {
    expect(() => machineBindingsFor([new FakeRuntime(), new WorkspaceRuntime()], name)).toThrow(
      refusal,
    )
  })

  it('says none when there is no machine', () => {
    expect(() => machineBindingsFor([new WorkspaceRuntime()], 'nope')).toThrow(
      /\(workspace machines: none\)/,
    )
  })

  it('takes no name a class is registered as', () => {
    registerRuntime('cpython-alias', FakeRuntime)
    expect(() =>
      machineBindingsFor([new FakeRuntime(), new WorkspaceRuntime()], 'cpython-alias'),
    ).toThrow(/unknown machine: 'cpython-alias'/)
  })
})

describe('buildEntry', () => {
  it.each<[Record<string, unknown>, string]>([
    [{ provider: 'worker' }, 'MontyRuntime'],
    [{ provider: 'in_process', runtime: 'quickjs' }, 'QuickJsRuntime'],
    [{ provider: 'in_process', runtime: FakeRuntime }, 'FakeRuntime'],
  ])('builds the runtime its provider runs: %j', (spec, cls) => {
    const [handle, runtime] = buildEntry('py', spec)
    expect([handle, runtime.constructor.name, runtime.name]).toEqual([null, cls, 'py'])
    expect(builtFrom(runtime)).toEqual(spec)
  })

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['py', { provider: 'worker', runtime: 'quickjs' }, /runs 'monty'/],
    ['py', { provider: 'in_process', runtime: 'monty' }, /on worker/],
    ['py', { provider: 'host', runtime: 'monty' }, /not a runtime/],
    ['py', { provider: 'worker', sandbox: {} }, /only a host/],
    ['py', { provider: 'host', sandbox: null }, /must be a mapping/],
    ['workspace', { provider: 'worker' }, /the shell's machine name/],
    ['py', { provider: 'in_process' }, /the shell's machine name/],
    ['py', { provider: 'in_process', runtime: 'ghost' }, /unknown/],
    ['py', { provider: 'in_process', runtime: 'remote' }, /provider/],
    ['py', { provider: 'in_process', runtime: Object }, /not a Runtime/],
  ])('refuses what its provider does not run: %s %j', (name, spec, refusal) => {
    expect(() => buildEntry(name, spec)).toThrow(refusal)
  })

  it('names the shell workspace alone', () => {
    const [, shell] = buildEntry('workspace', { provider: 'in_process' })
    expect(shell).toBeInstanceOf(WorkspaceRuntime)
    expect(builtFrom(shell)).toEqual({ provider: 'in_process' })
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
      registerRuntime('workspace', FakeRuntime)
    }).toThrow(/shadows a builtin/)
  })

  it('refuses a shipped name once its package registered it', () => {
    registerRuntime('sandlock', FakeRuntime)
    expect(() => {
      registerRuntime('sandlock', Other)
    }).toThrow(/shadows a builtin/)
    expect(buildRuntime('sandlock')).toBeInstanceOf(FakeRuntime)
  })

  it('says where an unregistered shipped runtime lives', () => {
    expect(() => buildRuntime('local')).toThrow(/@struktoai\/mirage-node/)
  })

  it('replaces a custom name', () => {
    registerRuntime('fake-replaced', FakeRuntime)
    registerRuntime('fake-replaced', Other)
    expect(buildRuntime('fake-replaced')).toBeInstanceOf(Other)
  })

  it('keeps the name an entry was built with', () => {
    registerRuntime('fake-first', FakeRuntime)
    registerRuntime('fake-second', FakeRuntime)
    const [, built] = buildEntry('py', { provider: 'in_process', runtime: 'fake-second' })
    expect(placement(built)).toEqual(['in_process', 'fake-second'])
    registerRuntime('fake-second', Other)
    expect(placement(built)).toEqual(['in_process', 'fake-second'])
  })
})

class Named extends Runtime {
  constructor(
    readonly name: string,
    ...captures: string[]
  ) {
    super({ captures })
  }
}

describe('shadowedCaptures', () => {
  it('names each capture an earlier entry wins', () => {
    const entries = [
      new Named('e2b', '@external', 'gcc'),
      new Named('docker', 'gcc', '@external', 'make'),
      new Named('box', '@line'),
      new Named('other', '@line'),
      new WorkspaceRuntime(),
    ]
    expect(shadowedCaptures(entries)).toEqual([
      ['gcc', 'e2b', 'docker'],
      ['@external', 'e2b', 'docker'],
      ['@line', 'box', 'other'],
    ])
    expect(shadowedCaptures([new Named('a', 'x'), new Named('b', 'y')])).toEqual([])
  })
})
