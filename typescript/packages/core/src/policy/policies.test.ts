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
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { Limit, MountMode, OnExceed, PathSpec, type Refusal } from '../types.ts'
import { MountRegistry } from '../workspace/mount/registry.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import type { Policy } from './base.ts'
import { MountRootPolicy } from './builtin/mount_root.ts'
import { PolicyDenied } from './errors.ts'
import {
  Policies,
  postExecuteGate,
  postOpsGate,
  preOpsGate,
  describeRefusal,
  saysWhy,
  refusalOf,
  renderDeny,
  renderPending,
} from './policies.ts'
import { RulePolicy } from './rule.ts'
import type {
  Action,
  CommandContext,
  Deny,
  ExecuteResultContext,
  CommandRule,
  OpsContext,
  OpsResultContext,
} from './types.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

class DenyWeird implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    if (ctx.command === 'weird') return { kind: 'deny', reason: 'nope' }
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
    if (ctx.op === 'read') return { kind: 'deny', reason: 'no reads' }
    return null
  }
}

class AskRm implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    if (ctx.command === 'rm') return { kind: 'ask', reason: 'sign-off' }
    return null
  }
}

class AskAll implements Policy {
  preCommand(_ctx: CommandContext): Action | null {
    return { kind: 'ask', reason: 'second opinion' }
  }
}

class DenyRm implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    if (ctx.command === 'rm') return { kind: 'deny', reason: 'no' }
    return null
  }
}

class AskOnOps implements Policy {
  preOps(_ctx: OpsContext): Action | null {
    return { kind: 'ask', reason: 'cannot wait here' }
  }
}

class DenyBigResults implements Policy {
  postOps(ctx: OpsResultContext): Action | null {
    if (ctx.result instanceof Uint8Array && ctx.result.length > 8) {
      return { kind: 'deny', reason: 'result too large' }
    }
    return null
  }
}

class ReadOnlyProd implements Policy {
  preOps(ctx: OpsContext): Action | null {
    if (ctx.write && ctx.path.virtual.startsWith('/data/prod/')) {
      return { kind: 'deny', reason: 'prod is frozen' }
    }
    return null
  }
}

class NoInterpreters implements Policy {
  async preCommand(ctx: CommandContext): Promise<Action | null> {
    await Promise.resolve()
    if (ctx.command === 'python3') {
      return { kind: 'deny', reason: 'interpreters are off' }
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
  deny?: readonly CommandRule[],
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
      ...(deny ? { profiles: { default: { commands: { allow: null, ask: [], deny } } } } : {}),
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
    expect(deny?.reason).toContain('Device or resource busy')
  })

  it('builtin runs first, then user policies in order', async () => {
    const policies = new Policies([new MountRootPolicy()])
    policies.add(new RulePolicy({ reason: 'user rule', commands: ['rm'] }))
    // Both match `rm /data`; the built-in GNU message wins by order.
    let deny = await policies.preCommand(ctx('rm', [path('/data')]))
    expect(deny?.reason).toContain('Device or resource busy')
    // Only the user rule matches `rm /data/x`.
    deny = await policies.preCommand(ctx('rm', [path('/data/x')]))
    expect(deny).toEqual({ kind: 'deny', reason: 'user rule', policy: 'RulePolicy' })
    // The command plane renders a whole-command refusal at 126 and an
    // operand one in the GNU voice at 1, whoever produced it.
    const text = (r: [Uint8Array, number]) => [new TextDecoder().decode(r[0]), r[1]]
    expect(text(renderDeny('rm', deny as Deny))).toEqual(['rm: Permission denied\n', 126])
    expect(
      text(renderDeny('rm', { kind: 'deny', reason: "cannot remove 'x'", scope: 'operand' })),
    ).toEqual(["rm: cannot remove 'x'\n", 1])
    expect(
      text(renderDeny('tar', { kind: 'deny', reason: 'x: Cannot open', scope: 'operand' })),
    ).toEqual(['tar: x: Cannot open\n', 2])
  })

  it('skips undefined hooks and honors policy instances', async () => {
    const policies = new Policies()
    policies.add(silent)
    policies.add(new DenyWeird())
    expect(await policies.preCommand(ctx('weird'))).toEqual({
      kind: 'deny',
      reason: 'nope',
      policy: 'DenyWeird',
    })
    expect(await policies.preCommand(ctx('normal'))).toBeNull()
  })

  it('a throwing policy fails closed', async () => {
    const policies = new Policies()
    policies.add(new Raising())
    const deny = await policies.preCommand(ctx('ls'))
    expect(deny?.kind).toBe('deny')
    expect(deny).not.toHaveProperty('scope')
    expect(deny?.reason).toBe('Raising failed')
    expect((deny as Deny).policy).toBe('Raising')
    expect((deny as Deny).failed).toBe(true)
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
    expect(deny).toEqual({ kind: 'deny', reason: 'no reads', policy: 'DenyReadOps' })
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

  it('add takes code only: a policy that also carries a reason field is just a policy', async () => {
    const policies = new Policies()
    const entry: Policy & { reason: string } = {
      reason: 'looks like a rule',
      preCommand: (c: CommandContext) =>
        c.command === 'weird' ? { kind: 'deny', reason: 'nope' } : null,
    }
    policies.add(entry)
    expect(await policies.preCommand(ctx('ls'))).toBeNull()
    expect(await policies.preCommand(ctx('weird'))).toEqual({
      kind: 'deny',
      reason: 'nope',
      policy: 'Object',
    })
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
      // A whole-command refusal is bash's "found but may not run".
      expect(refused.exitCode).toBe(126)
      expect(new TextDecoder().decode(refused.stderr)).toBe('python3: Permission denied\n')
      expect(refused.refusal).toEqual({
        kind: 'deny',
        reason: 'interpreters are off',
        policy: 'NoInterpreters',
        scope: 'command',
        askId: null,
      })
    } finally {
      await ws.close()
    }
  })

  it('the policies option accepts instances', async () => {
    const ws = executableWorkspace(undefined, [new NoInterpreters()])
    try {
      const refused = await ws.execute("python3 -c 'print(1)'")
      expect(refused.exitCode).toBe(126)
      expect(new TextDecoder().decode(refused.stderr)).toBe('python3: Permission denied\n')
      expect(refused.refusal).toEqual({
        kind: 'deny',
        reason: 'interpreters are off',
        policy: 'NoInterpreters',
        scope: 'command',
        askId: null,
      })
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
      expect(refused.exitCode).toBe(126)
      expect(new TextDecoder().decode(refused.stderr)).toBe('source: Permission denied\n')
      expect(refused.refusal).toEqual({
        kind: 'deny',
        reason: 'disabled',
        policy: 'PermissionsPolicy',
        scope: 'command',
        askId: null,
      })
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

  it('touch on an existing file is a write at the op door', async () => {
    // touch on an existing file mutates via setattr, not create; the
    // write classification must cover that op too.
    const ws = executableWorkspace()
    try {
      await ws.execute('mkdir -p /data/prod')
      await ws.dispatch('write', '/data/prod/x.txt', [new TextEncoder().encode('keep')])
      ws.policies.add(new ReadOnlyProd())
      const refused = await ws.execute('touch /data/prod/x.txt')
      expect(refused.exitCode).not.toBe(0)
      expect(new TextDecoder().decode(refused.stderr)).toContain('Permission denied')
    } finally {
      await ws.close()
    }
  })
})

class CapFour implements Policy {
  postOps(_ctx: OpsResultContext): Action | null {
    return new Limit({ maxBytes: 4 })
  }
}

class CapTwo implements Policy {
  postOps(_ctx: OpsResultContext): Action | null {
    return new Limit({ maxBytes: 2 })
  }
}

class LimitOnPre implements Policy {
  preCommand(_ctx: CommandContext): Action | null {
    return new Limit({ maxBytes: 1 })
  }
}

class CapLines implements Policy {
  postExecute(_ctx: ExecuteResultContext): Action | null {
    return new Limit({ maxLines: 2 })
  }
}

describe('Limit', () => {
  const opsCtx = (): OpsResultContext => ({
    op: 'read',
    path: path('/data/x'),
    write: false,
    prefix: '/data/',
    result: new TextEncoder().encode('payload'),
  })

  it('postOps limits merge to the tightest', async () => {
    const policies = new Policies()
    policies.add(new CapFour())
    policies.add(new CapTwo())
    const [deny, bound] = await policies.postOps(opsCtx())
    expect(deny).toBeNull()
    expect(bound?.maxBytes).toBe(2)
  })

  it('postOpsGate returns the merged bound', async () => {
    const policies = new Policies()
    policies.add(new CapFour())
    const bound = await postOpsGate(policies, 'read', path('/data/x'), false, '/data/', null)
    expect(bound?.maxBytes).toBe(4)
  })

  it('a limit is illegal on preCommand', async () => {
    const policies = new Policies()
    policies.add(new LimitOnPre())
    await expect(policies.preCommand(ctx('ls', []))).rejects.toThrow(/LimitOnPre/)
  })

  it('postExecuteGate merges user limits', async () => {
    const policies = new Policies()
    policies.add(new CapLines())
    const [deny, bound] = await postExecuteGate(policies, {
      producer: { command: 'echo', prefixes: [], declared: null },
      exitCode: 0,
    })
    expect(deny).toBeNull()
    expect(bound?.maxLines).toBe(2)
  })

  it('a user limit policy caps line output', async () => {
    const ws = executableWorkspace()
    try {
      ws.policies.add(new CapLines())
      await ws.dispatch('write', '/data/big.txt', [new TextEncoder().encode('1\n2\n3\n4\n5\n')])
      const r = await ws.execute('cat /data/big.txt')
      const out = new TextDecoder().decode(r.stdout)
      expect(out.split('\n').filter((l) => l !== '').length).toBe(2)
      expect(new TextDecoder().decode(r.stderr)).toContain('output truncated')
    } finally {
      await ws.close()
    }
  })

  it('a postOps limit caps the op door', async () => {
    const ws = executableWorkspace()
    try {
      ws.policies.add(new CapFour())
      await ws.dispatch('write', '/data/f.txt', [new TextEncoder().encode('hello world')])
      const served = await ws.dispatch('read', '/data/f.txt')
      expect(new TextDecoder().decode(served as Uint8Array)).toBe('hell')
    } finally {
      await ws.close()
    }
  })
})

class CapThree implements Policy {
  postExecute(_ctx: ExecuteResultContext): Action | null {
    return new Limit({ maxLines: 3 })
  }
}

class CapBytesHard implements Policy {
  postExecute(_ctx: ExecuteResultContext): Action | null {
    return new Limit({ maxBytes: 4, onExceed: OnExceed.ERROR })
  }
}

class Boom implements Policy {
  postExecute(_ctx: ExecuteResultContext): Action | null {
    throw new Error('boom')
  }
}

class DenyReads implements Policy {
  postOps(ctx: OpsResultContext): Action | null {
    return ctx.op === 'read' ? { kind: 'deny', reason: 'reads are suppressed' } : null
  }
}

class SeeProducer implements Policy {
  readonly seen: string[] = []
  postExecute(ctx: ExecuteResultContext): Action | null {
    this.seen.push(ctx.producer.command)
    return null
  }
}

describe('Limit end to end', () => {
  it('two limit policies merge to the tightest', async () => {
    const ws = executableWorkspace()
    try {
      ws.policies.add(new CapLines())
      ws.policies.add(new CapThree())
      await ws.dispatch('write', '/data/big.txt', [new TextEncoder().encode('1\n2\n3\n4\n5\n')])
      const r = await ws.execute('cat /data/big.txt')
      const out = new TextDecoder().decode(r.stdout)
      expect(out.split('\n').filter((l) => l !== '').length).toBe(2)
    } finally {
      await ws.close()
    }
  })

  it('an error-mode limit fails the line', async () => {
    const ws = executableWorkspace()
    try {
      ws.policies.add(new CapBytesHard())
      await ws.dispatch('write', '/data/f.txt', [new TextEncoder().encode('hello world\n')])
      const r = await ws.execute('cat /data/f.txt')
      expect(r.exitCode).toBe(1)
      expect(new TextDecoder().decode(r.stderr)).toContain('output truncated')
      const ok = await ws.execute('echo ok')
      expect(ok.exitCode).toBe(0)
      expect(new TextDecoder().decode(ok.stdout)).toBe('ok\n')
    } finally {
      await ws.close()
    }
  })

  it('a postOps deny beats a limit', async () => {
    const ws = executableWorkspace()
    try {
      ws.policies.add(new CapFour())
      ws.policies.add(new DenyReads())
      await ws.dispatch('write', '/data/f.txt', [new TextEncoder().encode('hello world')])
      await expect(ws.dispatch('read', '/data/f.txt')).rejects.toThrow(/reads are suppressed/)
    } finally {
      await ws.close()
    }
  })

  it('a throwing postExecute policy fails the line closed', async () => {
    const ws = executableWorkspace()
    try {
      ws.policies.add(new Boom())
      const r = await ws.execute('echo hi')
      expect(r.exitCode).toBe(126)
      const err = new TextDecoder().decode(r.stderr)
      expect(err).toBe('echo: Permission denied\n')
      expect(r.refusal).toEqual({
        kind: 'failed',
        reason: 'Boom failed',
        policy: 'Boom',
        scope: 'command',
        askId: null,
      })
    } finally {
      await ws.close()
    }
  })

  it('postExecute sees the rightmost producer', async () => {
    const ws = executableWorkspace()
    try {
      const spy = new SeeProducer()
      ws.policies.add(spy)
      await ws.dispatch('write', '/data/f.txt', [new TextEncoder().encode('a\nb\n')])
      await ws.execute('cat /data/f.txt | wc -l')
      await ws.execute('cat /data/f.txt ; head -n 1 /data/f.txt')
      await ws.execute('false || cat /data/f.txt')
      // Builtins carry provenance too: a policy keyed on echo sees it.
      await ws.execute('echo hi')
      await ws.execute('cat /data/f.txt ; echo done')
      expect(spy.seen).toEqual(['wc', 'head', 'cat', 'echo', 'echo'])
    } finally {
      await ws.close()
    }
  })
})

describe('Ask in the chain', () => {
  it('a deny anywhere in the chain outranks an ask', async () => {
    // The loop keeps looking past an Ask for a Deny, whichever order the
    // two policies were registered in, so an approval can never re-open
    // a refusal.
    for (const order of [
      [new AskRm(), new DenyRm()],
      [new DenyRm(), new AskRm()],
    ]) {
      const policies = new Policies(order)
      expect(await policies.preCommand(ctx('rm'))).toEqual({
        kind: 'deny',
        reason: 'no',
        policy: 'DenyRm',
      })
    }
    // With nothing refusing, the first Ask is the answer.
    const policies = new Policies([new AskRm(), new AskAll()])
    expect(await policies.preCommand(ctx('rm'))).toEqual({ kind: 'ask', reason: 'sign-off' })
    expect(await policies.preCommand(ctx('ls'))).toEqual({
      kind: 'ask',
      reason: 'second opinion',
    })
  })

  it('an ask is illegal off the command plane', async () => {
    const policies = new Policies([new AskOnOps()])
    await expect(
      policies.preOps({ op: 'write', path: path('/data/x'), write: true, prefix: '/data/' }),
    ).rejects.toThrow(/AskOnOps/)
  })

  it('renderPending names the approval', () => {
    const [err, code] = renderPending('git', { kind: 'pending', id: 'abc123', reason: 'sign-off' })
    expect(new TextDecoder().decode(err)).toBe('git: Permission denied\n')
    expect(code).toBe(126)
  })

  it('refusalOf records kind, policy, scope and ask', () => {
    expect(refusalOf({ kind: 'deny', reason: 'user rule', policy: 'RulePolicy' })).toEqual({
      kind: 'deny',
      reason: 'user rule',
      policy: 'RulePolicy',
      scope: 'command',
      askId: null,
    })
    expect(
      refusalOf({
        kind: 'deny',
        reason: "cannot remove 'x'",
        scope: 'operand',
        policy: 'MountRootPolicy',
      }),
    ).toEqual({
      kind: 'deny',
      reason: "cannot remove 'x'",
      policy: 'MountRootPolicy',
      scope: 'operand',
      askId: null,
    })
    expect(
      refusalOf({ kind: 'deny', reason: 'Raising failed', policy: 'Raising', failed: true }),
    ).toEqual({
      kind: 'failed',
      reason: 'Raising failed',
      policy: 'Raising',
      scope: 'command',
      askId: null,
    })
    expect(refusalOf({ kind: 'pending', id: 'abc123', reason: 'sign-off' })).toEqual({
      kind: 'pending',
      reason: 'sign-off',
      policy: '',
      scope: 'command',
      askId: 'abc123',
    })
  })

  it('describeRefusal carries the reason the stderr line dropped', () => {
    expect(
      describeRefusal({
        kind: 'deny',
        reason: 'user rule',
        policy: 'RulePolicy',
        scope: 'command',
        askId: null,
      }),
    ).toBe('policy denied: user rule')
    expect(
      describeRefusal({
        kind: 'pending',
        reason: 'sign-off',
        policy: '',
        scope: 'command',
        askId: 'abc123',
      }),
    ).toBe('requires approval: sign-off (ask abc123)')
    expect(
      describeRefusal({
        kind: 'failed',
        reason: 'Raising failed',
        policy: 'Raising',
        scope: 'command',
        askId: null,
      }),
    ).toBe('policy Raising failed')
  })

  it('saysWhy needs the operand diagnostic itself', () => {
    const operand: Refusal = {
      kind: 'deny',
      reason: '/protected: frozen',
      policy: 'Frozen',
      scope: 'operand',
      askId: null,
    }
    // The GNU line, wherever a redirect landed it.
    expect(saysWhy('cat: /protected: frozen\n', operand)).toBe(true)
    expect(saysWhy('partial\ncat: /protected: frozen\n', operand)).toBe(true)
    expect(saysWhy('', operand)).toBe(false)
    // The reason quoted inside other output is not the diagnostic.
    expect(saysWhy('note: /protected: frozen for now\n', operand)).toBe(false)
    // A command-scoped refusal's stderr is bash's bare line; output that
    // happens to carry the reason (or was left when 2>/dev/null took the
    // line away) has not said why.
    const denied: Refusal = {
      kind: 'deny',
      reason: 'no deletes',
      policy: 'RulePolicy',
      scope: 'command',
      askId: null,
    }
    expect(saysWhy('rm: Permission denied\n', denied)).toBe(false)
    expect(saysWhy('rm: Permission denied\nno deletes\n', denied)).toBe(false)
    expect(saysWhy('printf: no deletes\n', denied)).toBe(false)
    // An empty reason says nothing, so no text can already have said it.
    expect(
      saysWhy('cat: \n', { kind: 'deny', reason: '', policy: 'P', scope: 'operand', askId: null }),
    ).toBe(false)
  })
})

it('removes by identity, refreshes hooks and preserves an admission in progress', async () => {
  const policies = new Policies()
  const first: Policy = {
    preCommand: () => {
      expect(policies.remove(first)).toBe(true)
      return null
    },
  }
  const last = new DenyWeird()
  policies.add(first)
  policies.add(last)
  expect(policies.remove(new DenyWeird())).toBe(false)
  expect(await policies.preCommand(ctx('weird'))).toMatchObject({ kind: 'deny', reason: 'nope' })
  expect(policies.wants('preCommand')).toBe(true)
  expect(policies.remove(last)).toBe(true)
  expect(policies.wants('preCommand')).toBe(false)
  expect(policies.remove(first)).toBe(false)
  expect(await policies.preCommand(ctx('weird'))).toBeNull()
})
