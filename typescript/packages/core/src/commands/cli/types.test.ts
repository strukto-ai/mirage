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
import { ScriptSource } from '../../runtime/types.ts'
import { Argument, CommandSpec } from '../spec/types.ts'
import type { CommandOpts } from '../config.ts'
import { CLI, CLIHandler, type CLIView, type CLIVerbFn } from './types.ts'

const verb: CLIVerbFn = () => null
const configModel = (input: Record<string, unknown>) => input

describe('CLI registration', () => {
  it('freezes registrations and copies their handler mappings', () => {
    const handlers: Record<string, CLIHandler> = { '': new CLIHandler({ fn: verb }) }
    const cli = new CLI({ spec: new CommandSpec({ name: 'tool' }), handlers })
    delete handlers['']
    expect(cli.handlers['']?.fn).toBe(verb)
    expect(Object.isFrozen(cli.handlers)).toBe(true)
    expect(Object.isFrozen(cli.handlers[''])).toBe(true)
  })

  it('rejects missing handlers and handlers attached to groups or unknown paths', () => {
    expect(() => new CLI({ spec: new CommandSpec({ name: 'hello' }) })).toThrow(/missing handlers/)
    const spec = new CommandSpec({ name: 'hello', subcommands: [new CommandSpec({ name: 'run' })] })
    expect(
      () =>
        new CLI({
          spec,
          handlers: { run: new CLIHandler({ fn: verb }), '': new CLIHandler({ fn: verb }) },
        }),
    ).toThrow(/do not name leaves/)
    expect(
      () =>
        new CLI({ spec: new CommandSpec({ name: 'hello' }), handlers: { '': new CLIHandler() } }),
    ).toThrow(/needs a handler fn/)
  })

  it.each(['', 'gmail send', 'gmail\tsend', 'gmail\n'])('rejects invalid root name %j', (name) => {
    expect(
      () =>
        new CLI({
          spec: new CommandSpec({ name }),
          handlers: { '': new CLIHandler({ fn: verb }) },
        }),
    ).toThrow(/single non-empty word/)
  })

  it('rejects duplicate names and aliases, including a repeated alias', () => {
    for (const aliases of [['send'], ['co', 'co']]) {
      const spec = new CommandSpec({
        name: 'tool',
        subcommands: [new CommandSpec({ name: 'send', aliases })],
      })
      expect(() => new CLI({ spec, handlers: { send: new CLIHandler({ fn: verb }) } })).toThrow(
        /duplicate subcommand/,
      )
    }
    const spec = new CommandSpec({
      name: 'tool',
      subcommands: [
        new CommandSpec({ name: 'send', aliases: ['co'] }),
        new CommandSpec({ name: 'co' }),
      ],
    })
    expect(
      () =>
        new CLI({
          spec,
          handlers: { send: new CLIHandler({ fn: verb }), co: new CLIHandler({ fn: verb }) },
        }),
    ).toThrow(/duplicate subcommand/)
  })

  it('rejects positional arguments on groups', () => {
    for (const nargs of ['?', '*'] as const) {
      const spec = new CommandSpec({
        name: 'tool',
        arguments: [new Argument('value', { nargs })],
        subcommands: [new CommandSpec({ name: 'run' })],
      })
      expect(() => new CLI({ spec, handlers: { run: new CLIHandler({ fn: verb }) } })).toThrow(
        /positional arguments belong on leaves/,
      )
    }
  })

  it('compiles every node and rejects conflicting ancestor option destinations', () => {
    const spec = new CommandSpec({
      name: 'tool',
      arguments: [new Argument('--token')],
      subcommands: [new CommandSpec({ name: 'run', arguments: [new Argument('--token')] })],
    })
    expect(() => new CLI({ spec, handlers: { run: new CLIHandler({ fn: verb }) } })).toThrow(
      /collides with subcommand/,
    )
    expect(
      () =>
        new CLI({
          spec: new CommandSpec({ name: 'tool', arguments: [new Argument([])] }),
          handlers: { '': new CLIHandler({ fn: verb }) },
        }),
    ).toThrow(/requires a name or option spelling/)
  })

  it('allows sibling options to share a destination', () => {
    const spec = new CommandSpec({
      name: 'tool',
      subcommands: ['send', 'share'].map(
        (name) => new CommandSpec({ name, arguments: [new Argument('--token')] }),
      ),
    })
    expect(
      new CLI({
        spec,
        handlers: { send: new CLIHandler({ fn: verb }), share: new CLIHandler({ fn: verb }) },
      }).spec,
    ).toBe(spec)
  })

  it('keeps script execution outside grammar and suppresses injected help for opaque argv', () => {
    const cli = new CLI({
      spec: new CommandSpec({ name: 'pager' }),
      script: new ScriptSource('1'),
      runtime: 'monty',
    })
    expect(cli.spec.addHelp).toBe(false)
    expect(cli.runtime).toBe('monty')
    expect(cli.handlers['']?.fn).toBeNull()
  })

  it('rejects incompatible script execution settings', () => {
    const spec = new CommandSpec({ name: 'pager' })
    const script = new ScriptSource('1')
    expect(() => new CLI({ spec, script, configModel })).toThrow(/configModel/)
    expect(() => new CLI({ spec, script, handlers: { '': new CLIHandler({ fn: verb }) } })).toThrow(
      /fn or script, not both/,
    )
    expect(
      () => new CLI({ spec, runtime: 'monty', handlers: { '': new CLIHandler({ fn: verb }) } }),
    ).toThrow(/it takes script/)
    expect(
      () =>
        new CLI({
          spec: new CommandSpec({ name: 'pager', subcommands: [new CommandSpec({ name: 'run' })] }),
          script,
        }),
    ).toThrow(/serves the whole program/)
  })
})

describe('view parity with the command tier', () => {
  it('spells every view field the way CommandOpts spells it', () => {
    type Shared = { [K in keyof CLIView]: CommandOpts[K] }
    const parity: Shared = {} as CLIView
    expect(parity).toBeDefined()
  })
})
