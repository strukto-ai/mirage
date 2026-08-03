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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'

import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode, PathSpec } from '../types.ts'
import { MountRegistry } from '../workspace/mount/registry.ts'
import { Workspace } from '../workspace/workspace.ts'
import type { Policy } from './base.ts'
import { MountRootPolicy } from './mount_root.ts'
import { Policies } from './policies.ts'
import type { GuardSpec } from './spec.ts'
import type { Action, CommandContext } from './types.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

class DenyWeird implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    if (ctx.command === 'weird') return { kind: 'deny', message: 'nope\n', exitCode: 3 }
    return null
  }
}

class Raising implements Policy {
  preCommand(_ctx: CommandContext): Action | null {
    throw new Error('boom')
  }
}

class IllegalReturn implements Policy {
  preCommand(_ctx: CommandContext): Action | null {
    return 'not an action' as unknown as Action
  }
}

const silent: Policy = {}

class NoInterpreters implements Policy {
  async preCommand(ctx: CommandContext): Promise<Action | null> {
    await Promise.resolve()
    if (ctx.command === 'python3') {
      return { kind: 'deny', message: 'python3: interpreters are off\n', exitCode: 1 }
    }
    return null
  }
}

function registry(): MountRegistry {
  return new MountRegistry({ '/data': new RAMResource() }, MountMode.WRITE, {})
}

function path(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: '',
    rawPath: virtual,
    resolved: true,
  })
}

function ctx(command: string, paths: PathSpec[] = [], reg?: MountRegistry): CommandContext {
  return { command, paths, argv: [], cwd: '/', registry: reg ?? registry() }
}

function executableWorkspace(
  guards?: readonly GuardSpec[],
  policies?: readonly Policy[],
): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  ops.registerResource(ram)
  return new Workspace(
    { '/data/': ram },
    {
      mode: MountMode.WRITE,
      ops,
      shellParser: parser,
      ...(guards ? { guards } : {}),
      ...(policies ? { policies } : {}),
    },
  )
}

describe('Policies', () => {
  it('carries no rules by default', async () => {
    expect(await new Policies().preCommand(ctx('rm', [path('/data')]))).toBeNull()
  })

  it('registry seeds the mount-root policy', async () => {
    const reg = registry()
    const deny = await reg.policies.preCommand(ctx('rm', [path('/data')], reg))
    expect(deny?.message).toContain('Device or resource busy')
  })

  it('builtin runs first, then user policies in order', async () => {
    const policies = new Policies([new MountRootPolicy()])
    policies.add({ reason: 'user rule', commands: ['rm'] })
    // Both match `rm /data`; the built-in GNU message wins by order.
    let deny = await policies.preCommand(ctx('rm', [path('/data')]))
    expect(deny?.message).toContain('Device or resource busy')
    // Only the user rule matches `rm /data/x`.
    deny = await policies.preCommand(ctx('rm', [path('/data/x')]))
    expect(deny?.message).toBe('rm: user rule\n')
  })

  it('skips undefined hooks and honors policy instances', async () => {
    const policies = new Policies()
    policies.add(silent)
    policies.add(new DenyWeird())
    expect((await policies.preCommand(ctx('weird')))?.exitCode).toBe(3)
    expect(await policies.preCommand(ctx('normal'))).toBeNull()
  })

  it('a throwing policy fails closed', async () => {
    const policies = new Policies()
    policies.add(new Raising())
    const deny = await policies.preCommand(ctx('ls'))
    expect(deny?.exitCode).toBe(1)
    expect(deny?.message).toContain('Raising')
    expect(deny?.message).toContain('boom')
  })

  it('an illegal return throws PolicyError', async () => {
    const policies = new Policies()
    policies.add(new IllegalReturn())
    await expect(policies.preCommand(ctx('ls'))).rejects.toThrow(/IllegalReturn/)
  })
})

describe('workspace policies', () => {
  it('guards refuse before backend I/O and leave other paths open', async () => {
    const ws = executableWorkspace([
      {
        reason: 'production data is protected',
        commands: ['rm'],
        paths: ['/data/prod/*'],
      },
    ])
    try {
      await ws.execute('mkdir -p /data/prod && echo keep > /data/prod/x.txt')
      const refused = await ws.execute('rm /data/prod/x.txt')
      expect(refused.exitCode).toBe(1)
      expect(new TextDecoder().decode(refused.stderr)).toBe(
        'rm: /data/prod/x.txt: production data is protected\n',
      )
      const intact = await ws.execute('cat /data/prod/x.txt')
      expect(new TextDecoder().decode(intact.stdout)).toBe('keep\n')
    } finally {
      await ws.close()
    }
  })

  it('ws.policies.add wins over runtime placement', async () => {
    // python3 is runtime-bound in the default world; the preCommand
    // hook fires ahead of runtime resolution, so the refusal wins.
    const ws = executableWorkspace()
    try {
      ws.policies.add(new NoInterpreters())
      const refused = await ws.execute("python3 -c 'print(1)'")
      expect(refused.exitCode).toBe(1)
      expect(new TextDecoder().decode(refused.stderr)).toBe('python3: interpreters are off\n')
    } finally {
      await ws.close()
    }
  })

  it('the policies option accepts instances', async () => {
    const ws = executableWorkspace(undefined, [new NoInterpreters()])
    try {
      const refused = await ws.execute("python3 -c 'print(1)'")
      expect(refused.exitCode).toBe(1)
      expect(new TextDecoder().decode(refused.stderr)).toBe('python3: interpreters are off\n')
    } finally {
      await ws.close()
    }
  })
})
