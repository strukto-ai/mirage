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
import { PolicyDenied } from './errors.ts'
import { Policies, postOpsGate, preOpsGate } from './policies.ts'
import type { Action, CommandContext, GuardSpec, OpsContext, OpsResultContext } from './types.ts'

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

class DenyReadOps implements Policy {
  preOps(ctx: OpsContext): Action | null {
    if (ctx.op === 'read') return { kind: 'deny', message: 'no reads\n', exitCode: 1 }
    return null
  }
}

class DenyBigResults implements Policy {
  postOps(ctx: OpsResultContext): Action | null {
    if (ctx.result instanceof Uint8Array && ctx.result.length > 8) {
      return { kind: 'deny', message: 'result too large\n', exitCode: 1 }
    }
    return null
  }
}

class ReadOnlyProd implements Policy {
  preOps(ctx: OpsContext): Action | null {
    if (ctx.write && ctx.path.virtual.startsWith('/data/prod/')) {
      return { kind: 'deny', message: 'prod is frozen\n', exitCode: 1 }
    }
    return null
  }
}

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

  it('preOps first deny wins and wants() gates', async () => {
    const policies = new Policies()
    expect(policies.wants('preOps')).toBe(false)
    policies.add(new DenyReadOps())
    expect(policies.wants('preOps')).toBe(true)
    expect(policies.wants('postOps')).toBe(false)
    const deny = await policies.preOps({
      op: 'read',
      path: path('/data/x'),
      write: false,
      prefix: '/data/',
    })
    expect(deny?.message).toBe('no reads\n')
    expect(
      await policies.preOps({ op: 'write', path: path('/data/x'), write: true, prefix: '/data/' }),
    ).toBeNull()
  })

  it('preOpsGate throws PolicyDenied with the EACCES stamp', async () => {
    const policies = new Policies()
    policies.add(new DenyReadOps())
    await expect(preOpsGate(policies, 'read', path('/data/x'), false, '/data/')).rejects.toThrow(
      PolicyDenied,
    )
    try {
      await preOpsGate(policies, 'read', path('/data/x'), false, '/data/')
    } catch (err) {
      expect((err as PolicyDenied).code).toBe('EACCES')
      expect((err as PolicyDenied).virtualPath).toBe('/data/x')
      expect((err as PolicyDenied).message).toBe('no reads')
    }
    // No opinion on writes: the gate passes silently.
    await preOpsGate(policies, 'write', path('/data/x'), true, '/data/')
  })

  it('postOpsGate suppresses the result', async () => {
    const policies = new Policies()
    policies.add(new DenyBigResults())
    await postOpsGate(policies, 'read', path('/data/x'), false, '/data/', new Uint8Array(4))
    await expect(
      postOpsGate(policies, 'read', path('/data/x'), false, '/data/', new Uint8Array(64)),
    ).rejects.toThrow(/result too large/)
  })

  it('an entry with a hook is a policy even if it carries reason', async () => {
    const policies = new Policies()
    const entry: Policy & { reason: string } = {
      reason: 'looks like a spec',
      preCommand: (c: CommandContext) =>
        c.command === 'weird' ? { kind: 'deny', message: 'nope\n', exitCode: 1 } : null,
    }
    policies.add(entry)
    // Misread as a GuardSpec this would deny EVERY command.
    expect(await policies.preCommand(ctx('ls'))).toBeNull()
    expect((await policies.preCommand(ctx('weird')))?.message).toBe('nope\n')
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

  it('guards cover shell builtins and namespace routes', async () => {
    // source is a dispatch-level shell builtin and touch is
    // namespace-routed; neither reaches handleCommand, so this pins
    // the hook at the dispatch chokepoint.
    const ws = executableWorkspace([
      { reason: 'disabled', commands: ['source'] },
      { reason: 'frozen', commands: ['touch'], paths: ['/data/prod/*'] },
    ])
    try {
      const refused = await ws.execute('source /data/setup.sh')
      expect(refused.exitCode).toBe(1)
      expect(new TextDecoder().decode(refused.stderr)).toBe('source: disabled\n')
      const frozen = await ws.execute('touch /data/prod/x')
      expect(frozen.exitCode).toBe(1)
      expect(new TextDecoder().decode(frozen.stderr)).toContain('frozen')
      const ok = await ws.execute('touch /data/dev-x && echo done')
      expect(new TextDecoder().decode(ok.stdout)).toContain('done')
    } finally {
      await ws.close()
    }
  })

  it('guards cover path-valued flags', async () => {
    // shuf discovers its output path from -o, not a positional
    // operand; the policy context must include flag-valued paths.
    const ws = executableWorkspace([
      { reason: 'prod is protected', commands: ['shuf'], paths: ['/data/prod/*'] },
    ])
    try {
      await ws.execute('mkdir -p /data/prod')
      const refused = await ws.execute('shuf -e a -o /data/prod/out')
      expect(refused.exitCode).toBe(1)
      expect(new TextDecoder().decode(refused.stderr)).toContain('prod is protected')
      const listing = await ws.execute('ls /data/prod')
      expect(new TextDecoder().decode(listing.stdout)).not.toContain('out')
    } finally {
      await ws.close()
    }
  })

  it('path guards hold at the programmatic door', async () => {
    // ws.dispatch is the one TS op door (FUSE routes through it); a
    // path-only guard must refuse it, not just shell commands (#675).
    const ws = executableWorkspace([{ reason: 'prod is protected', paths: ['/data/prod/*'] }])
    try {
      await ws.execute('mkdir -p /data/other')
      await ws.dispatch('write', '/data/other/ok.txt', [new TextEncoder().encode('fine')])
      await expect(
        ws.dispatch('write', '/data/prod/x.txt', [new TextEncoder().encode('nope')]),
      ).rejects.toThrow(PolicyDenied)
      await expect(ws.dispatch('read', '/data/prod/x.txt')).rejects.toThrow(/prod is protected/)
    } finally {
      await ws.close()
    }
  })

  it('a preOps policy holds on the shell door', async () => {
    // touch routes through the dispatcher, not handleCommand; a
    // preOps-only policy must still refuse it with GNU wording.
    const ws = executableWorkspace()
    try {
      ws.policies.add(new ReadOnlyProd())
      await ws.execute('mkdir -p /data/prod')
      const refused = await ws.execute('touch /data/prod/x')
      expect(refused.exitCode).not.toBe(0)
      expect(new TextDecoder().decode(refused.stderr)).toContain('Permission denied')
      const ok = await ws.execute('touch /data/free && echo done')
      expect(new TextDecoder().decode(ok.stdout)).toContain('done')
    } finally {
      await ws.close()
    }
  })
})
