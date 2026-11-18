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
import { cliSpecFor } from '../../commands/cli/specs.ts'
import { CLI, CLIHandler } from '../../commands/cli/types.ts'
import { Argument, CommandSpec } from '../../commands/spec/types.ts'
import { IOResult } from '../../io/types.ts'
import { commandTree, SessionProfile, treeDoc } from '../../policy/profile.ts'
import type { Grammar } from '../../policy/types.ts'
import { trees } from '../../test-utils.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace.ts'
import { BUILTIN_GRAMMARS, normalizeTree, renormalized } from './validate.ts'

// Mirrors python/tests/workspace/session/test_validate.py.

function noopVerb(): [null, IOResult] {
  return [null, new IOResult()]
}

function prog(): CLI {
  return new CLI({
    spec: new CommandSpec({
      name: 'prog',
      subcommands: [
        new CommandSpec({
          name: 'run',
          aliases: ['go'],
          arguments: [new Argument(['-v', '--verbose'], { action: 'store_true' })],
        }),
      ],
    }),
    handlers: { run: new CLIHandler({ fn: noopVerb }) },
  })
}

class Serving extends RAMVFS {
  constructor(private readonly cli: CLI) {
    super()
  }

  override commands(): readonly CLI[] {
    return [this.cli]
  }
}

function tool(verb: string): CLI {
  return new CLI({
    spec: new CommandSpec({
      name: 'tool',
      subcommands: [new CommandSpec({ name: verb, aliases: ['go'] })],
    }),
    handlers: { [verb]: new CLIHandler({ fn: noopVerb }) },
  })
}

function twoMounts(commands: Record<string, unknown>): Workspace {
  return new Workspace(
    { '/a': new RAMVFS(), '/b': new RAMVFS() },
    { profiles: { default: SessionProfile({ commands }) } },
  )
}

async function exits(ws: Workspace, line: string): Promise<number[]> {
  const out: number[] = []
  for (const cwd of ['/a', '/b']) out.push((await ws.shell(`cd ${cwd} && ${line}`)).exitCode)
  return out
}

function permissions(commands: Record<string, unknown>): { permissions: SessionProfile } {
  return { permissions: SessionProfile({ commands }) }
}

describe('a workspace checks command trees against its grammars', () => {
  it('createSession reads the verbs of an installed CLI', () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    ws.registerCli('prog', prog())
    expect(() => ws.createSession('bad', permissions({ prog: { walk: 'deny' } }))).toThrow(
      'no subcommand walk',
    )
    const good = ws.createSession('good', permissions({ prog: { go: { '-v': 'deny' } } }))
    const held = good.commands?.trees[0]
    expect(held === undefined ? null : treeDoc(held.tree)).toEqual({
      prog: { run: { '--verbose': 'deny' } },
    })
  })

  it('createSession reads the verbs of a tree a mount serves', () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    ws.mount('/data').registerCommands([
      new CLI({
        spec: new CommandSpec({
          name: 'tool',
          subcommands: [
            new CommandSpec({
              name: 'peek',
              arguments: [new Argument(['--all'], { action: 'store_true' })],
            }),
          ],
        }),
        handlers: { peek: new CLIHandler({ fn: noopVerb }) },
      }),
    ])
    expect(() => ws.createSession('bad', permissions({ tool: { poke: 'deny' } }))).toThrow(
      'no subcommand poke',
    )
    ws.createSession('good', permissions({ tool: { peek: { '--all': 'deny' } } }))
  })

  it('createSession refuses options on a command with no grammar', () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    expect(() => ws.createSession('bad', permissions({ prog: { '--verbose': 'deny' } }))).toThrow(
      'no grammar here',
    )
    ws.createSession('good', permissions({ prog: { operands: { x: 'deny' } } }))
  })

  it('checks every profile when the workspace is created', () => {
    expect(
      () =>
        new Workspace(
          { '/data': new RAMVFS() },
          { profiles: { unused: SessionProfile({ commands: { rm: { '--amdin': 'deny' } } }) } },
        ),
    ).toThrow('no option --amdin')
    expect(
      () =>
        new Workspace(
          { '/data': new RAMVFS() },
          {
            clis: { prog: [prog(), null] },
            profiles: { unused: SessionProfile({ commands: { prog: { walk: 'deny' } } }) },
          },
        ),
    ).toThrow('no subcommand walk')
  })

  it('a profile naming a CLI registered later waits for it', () => {
    const doc = SessionProfile({ commands: { prog: { go: 'deny' } } })
    const ws = new Workspace({ '/data': new RAMVFS() }, { profiles: { default: doc } })
    expect(() => ws.createSession('early', { profile: 'default' })).toThrow(
      'go is no subcommand here',
    )
    ws.registerCli('prog', prog())
    const held = ws.getSession(ws.defaultSessionId).commands?.trees[0]
    expect(held === undefined ? null : treeDoc(held.tree)).toEqual({ prog: { run: 'deny' } })
    ws.createSession('late', { profile: 'default' })
  })

  it('a mount serving a CLI later renames the rules naming it', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        profiles: { default: SessionProfile({ commands: { prog: { go: 'deny' } } }) },
      },
    )
    try {
      ws.mount('/data').registerCommands([prog()])
      for (const verb of ['go', 'run']) {
        const ran = await ws.shell(`cd /data && prog ${verb}`)
        expect(ran.exitCode).toBe(126)
      }
    } finally {
      await ws.close()
    }
  })

  it('a mount refuses a CLI a profile names wrongly', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        profiles: { p: SessionProfile({ commands: { prog: { walk: 'deny' } } }) },
      },
    )
    try {
      expect(() => {
        ws.mount('/data').registerCommands([prog()])
      }).toThrow('no subcommand walk')
      const ran = await ws.shell('cd /data && prog run')
      expect(ran.exitCode).toBe(127)
    } finally {
      await ws.close()
    }
  })

  it('two mounts serving one name must read a rule alike', async () => {
    const ws = twoMounts({ tool: { go: 'deny' } })
    try {
      ws.mount('/a').registerCommands([tool('publish')])
      expect(() => {
        ws.mount('/b').registerCommands([tool('send')])
      }).toThrow('two mounts serve tool')
      expect(await exits(ws, 'tool go')).toEqual([126, 126])
    } finally {
      await ws.close()
    }
  })

  it('one CLI on two mounts reads a rule alike', async () => {
    const shared = tool('send')
    const ws = twoMounts({ tool: { go: 'deny' } })
    try {
      ws.mount('/a').registerCommands([shared])
      ws.mount('/b').registerCommands([shared])
      expect(await exits(ws, 'tool go')).toEqual([126, 126])
    } finally {
      await ws.close()
    }
  })

  it('a rule on the command alone holds over two trees', async () => {
    const ws = twoMounts({ tool: 'deny' })
    try {
      ws.mount('/a').registerCommands([tool('publish')])
      ws.mount('/b').registerCommands([tool('send')])
      expect(await exits(ws, 'tool go')).toEqual([126, 126])
    } finally {
      await ws.close()
    }
  })

  it('a session naming what two trees read differently is refused', async () => {
    const ws = new Workspace({ '/a': new RAMVFS(), '/b': new RAMVFS() })
    try {
      ws.mount('/a').registerCommands([tool('publish')])
      ws.mount('/b').registerCommands([tool('send')])
      expect(() =>
        ws.createSession('go', { profile: SessionProfile({ commands: { tool: { go: 'deny' } } }) }),
      ).toThrow('two mounts serve tool')
      expect(() =>
        ws.createSession('publish', {
          profile: SessionProfile({ commands: { tool: { publish: 'deny' } } }),
        }),
      ).toThrow('no subcommand publish')
    } finally {
      await ws.close()
    }
  })

  it('a mount added serving a CLI meets the rules naming it', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { profiles: { default: SessionProfile({ commands: { prog: { go: 'deny' } } }) } },
    )
    try {
      ws.addMount('/late', new Serving(prog()))
      for (const verb of ['go', 'run']) {
        expect((await ws.shell(`cd /late && prog ${verb}`)).exitCode).toBe(126)
      }
    } finally {
      await ws.close()
    }
  })

  it('a mount added serving a CLI a profile names wrongly is refused', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { profiles: { p: SessionProfile({ commands: { prog: { walk: 'deny' } } }) } },
    )
    try {
      expect(() => ws.addMount('/late', new Serving(prog()))).toThrow('no subcommand walk')
      expect((await ws.shell('cd /late')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('registerCli refuses a CLI a profile names wrongly', () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { profiles: { p: SessionProfile({ commands: { prog: { walk: 'deny' } } }) } },
    )
    expect(() => ws.registerCli('prog', prog())).toThrow('no subcommand walk')
    expect(ws.clis().has('prog')).toBe(false)
  })

  it('renormalized holds a deferred tree by the grammar it has now', () => {
    const held = trees({ prog: { go: { '-v': 'deny' } } }, {}, { rm: 'deny' })
    const now = new Map(BUILTIN_GRAMMARS)
    now.set('prog', { spec: prog().spec, tree: true, passthrough: false })
    const again = renormalized(held, now)
    const first = again?.trees[0]
    expect(first === undefined ? null : treeDoc(first.tree)).toEqual({
      prog: { run: { '--verbose': 'deny' } },
    })
    expect(again?.trees[1]?.inline).toBe(true)
    expect(renormalized(null, now)).toBeNull()
  })
})

const grammars = (): Map<string, Grammar> => {
  const out = new Map(BUILTIN_GRAMMARS)
  for (const name of ['gh', 'git'])
    out.set(name, { spec: cliSpecFor(name).spec, tree: true, passthrough: false })
  return out
}

const normalized = (doc: unknown, defer = false): Record<string, unknown> =>
  treeDoc(normalizeTree(commandTree(doc), grammars(), 'commands', defer))

describe('normalizeTree', () => {
  it('holds each name by its canonical spelling', () => {
    const written = {
      rm: { '-r': 'ask', '-f': 'deny', '-i': 'allow' },
      gh: { pr: { ls: 'deny', merge: { '-R': 'ask' } } },
      git: { '-C': 'deny', checkout: { operands: { main: 'deny' } } },
      head: { '-n': { values: { '-5': 'deny' } } },
    }
    expect(normalized(written)).toEqual({
      rm: { '--recursive': 'ask', '--force': 'deny', '-i': 'allow' },
      gh: { pr: { list: 'deny', merge: { '--repo': 'ask' } } },
      git: { '-C': 'deny', checkout: { operands: { main: 'deny' } } },
      head: { '--lines': { values: { '-5': 'deny' } } },
    })
  })

  it.each([
    [{ gh: { pr: { mrge: 'deny' } } }, 'no subcommand mrge'],
    [{ gh: { pr: { merge: { '--amdin': 'deny' } } } }, 'no option --amdin'],
    [
      { gh: { pr: { merge: { admin: 'deny' } } } },
      'admin is no subcommand here; an operand goes under operands',
    ],
    [{ gh: { operands: { x: 'deny' } } }, 'takes a subcommand'],
    [{ kubectl: { '--namespace': 'deny' } }, 'no grammar here'],
    [{ kubectl: { get: 'deny' } }, 'get is no subcommand here'],
    [{ rm: { '-r': 'ask', '--recursive': 'deny' } }, 'same option'],
    [{ gh: { pr: { ls: 'deny', list: 'allow' } } }, 'same subcommand'],
    [{ rm: { '-rf': 'deny' } }, 'cluster of options; write -r and -f'],
    [{ git: { '-f': 'deny' } }, '-f names different options below'],
    [{ rm: { '--force': { values: { x: 'deny' } } } }, 'takes no value'],
    [{ git: { status: { '-u': { values: { some: 'deny' } } } } }, "takes none of 'some'"],
  ])('refuses a name its grammar lacks or reads two ways %#', (doc, says) => {
    expect(() => normalizeTree(commandTree(doc), grammars())).toThrow(says)
  })

  it('keeps operands on a command with no grammar, and can wait for one', () => {
    expect(normalized({ kubectl: { operands: { get: 'deny' } } })).toEqual({
      kubectl: { operands: { get: 'deny' } },
    })
    expect(normalized({ kubectl: { '--namespace': 'deny' } }, true)).toEqual({
      kubectl: { '--namespace': 'deny' },
    })
  })

  it('waits for no grammar on a shell builtin', () => {
    expect(() => normalized({ printenv: { GATED: 'deny' } }, true)).toThrow(
      'commands.printenv: GATED is no subcommand here; an operand goes under operands',
    )
    expect(normalized({ printenv: { operands: { GATED: 'deny' } } }, true)).toEqual({
      printenv: { operands: { GATED: 'deny' } },
    })
  })
})
