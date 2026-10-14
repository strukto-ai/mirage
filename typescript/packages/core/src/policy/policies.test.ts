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

import { RAMVFS } from '../vfs/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { Limit, MountMode, OnExceed, PathSpec } from '../types.ts'
import { MountRegistry } from '../workspace/mount/registry.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import type { Policy } from './base.ts'
import { ebusy } from '../errors/fs.ts'
import { MountRootPolicy } from './builtin/mount_root.ts'
import { PolicyDenied } from './errors.ts'
import {
  Policies,
  getOpPolicies,
  postExecuteGate,
  postVfsGate,
  preVfsGate,
  describeRefusal,
  refusalOf,
  renderDeny,
  runWithOpPolicies,
} from './policies.ts'
import { RulePolicy } from './rule.ts'
import { scriptContext } from './script.ts'
import { Outcome, type RouteContext } from './types.ts'
import type {
  Action,
  Ask,
  CommandContext,
  CommandResultContext,
  Decision,
  Deny,
  ExecuteResultContext,
  CommandRule,
  SessionContext,
  SessionResultContext,
  VfsContext,
  VfsResultContext,
  Route,
} from './types.ts'
import { CALLS } from '../workspace/dispatcher/constants.ts'
import type { VfsCall } from '../vfs/types.ts'

function callOf(name: string): VfsCall {
  const call = CALLS.get(name)
  if (call === undefined) throw new Error(`no call ${name}`)
  return call
}

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
  preVfs(ctx: VfsContext): Action | null {
    if (ctx.call.name === 'read') return { kind: 'deny', reason: 'no reads' }
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
  preVfs(_ctx: VfsContext): Action | null {
    return { kind: 'ask', reason: 'cannot wait here' }
  }
}

class DenyBigResults implements Policy {
  postVfs(ctx: VfsResultContext): Action | null {
    if (ctx.result instanceof Uint8Array && ctx.result.length > 8) {
      return { kind: 'deny', reason: 'result too large' }
    }
    return null
  }
}

class SuppressCapacity implements Policy {
  postVfs(ctx: VfsResultContext): Action | null {
    return ctx.call.name === 'statfs' ? { kind: 'deny', reason: 'no capacity' } : null
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
  return new MountRegistry({ '/data': new RAMVFS() }, MountMode.WRITE, {})
}

function path(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: '',
    rawPath: virtual,
    resolved: true,
  })
}

function ctx(command: string, paths: PathSpec[] = []): CommandContext {
  return { command, paths, argv: [], cwd: '/' }
}

function leaves(node: Record<string, unknown>): [string, number][] {
  const children = (node.children ?? []) as Record<string, unknown>[]
  if (children.length === 0) {
    return [[typeof node.command === 'string' ? node.command : '', Number(node.exitCode)]]
  }
  return children.flatMap(leaves)
}

function recordPaths(node: Record<string, unknown>): unknown[] {
  const mine = ((node.records ?? []) as Record<string, unknown>[]).map((r) => r.path)
  const children = (node.children ?? []) as Record<string, unknown>[]
  return [...mine, ...children.flatMap(recordPaths)]
}

function executableWorkspace(
  deny?: readonly CommandRule[],
  policies?: readonly Policy[],
): Workspace {
  const ram = new RAMVFS()
  return new Workspace(
    { '/data/': ram },
    {
      mode: MountMode.WRITE,
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
    const deny = await reg.policies.preCommand(ctx('rm', [path('/data')]))
    expect(deny?.reason).toContain("cannot remove '/data'")
  })

  it('builtin runs first, then user policies in order', async () => {
    const policies = new Policies([new MountRootPolicy(registry())])
    policies.add(new RulePolicy({ reason: 'user rule', commands: ['rm'] }))
    // Both match `rm /data`; the built-in GNU message wins by order.
    let deny = await policies.preCommand(ctx('rm', [path('/data')]))
    expect(deny?.reason).toContain('Is a directory')
    // Only the user rule matches `rm /data/x`.
    deny = await policies.preCommand(ctx('rm', [path('/data/x')]))
    expect(deny).toEqual({ kind: 'deny', reason: 'user rule', policy: 'RulePolicy' })
    // The command plane renders a whole-command refusal at 126, one about
    // a path in the GNU voice at 1, and one carrying an error as the
    // command's own line, whoever produced it.
    const text = (r: [Uint8Array, number]) => [new TextDecoder().decode(r[0]), r[1]]
    expect(text(renderDeny('rm', deny as Deny))).toEqual(['rm: Permission denied\n', 126])
    expect(text(renderDeny('cat', { kind: 'deny', reason: 'sealed', path: '/k' }))).toEqual([
      'cat: /k: Permission denied\n',
      1,
    ])
    const busy = ebusy('/x')
    expect(
      text(renderDeny('rm', { kind: 'deny', reason: "cannot remove 'x'", error: busy })),
    ).toEqual(["rm: cannot remove 'x'\n", 1])
    expect(
      text(renderDeny('tar', { kind: 'deny', reason: 'x: Cannot open', error: busy })),
    ).toEqual(['tar: x: Cannot open\n', 2])
  })

  it('skips undefined methods and honors policy instances', async () => {
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
    expect(deny).not.toHaveProperty('path')
    expect(deny?.reason).toBe('Raising failed')
    expect((deny as Deny).policy).toBe('Raising')
    expect((deny as Deny).failed).toBe(true)
  })

  it('an illegal return throws PolicyError', async () => {
    const policies = new Policies()
    policies.add(new IllegalReturn())
    await expect(policies.preCommand(ctx('ls'))).rejects.toThrow(/IllegalReturn/)
  })

  it('preVfs first deny wins and wants() gates', async () => {
    const policies = new Policies()
    expect(policies.wants('preVfs')).toBe(false)
    policies.add(new DenyReadOps())
    expect(policies.wants('preVfs')).toBe(true)
    expect(policies.wants('postVfs')).toBe(false)
    const deny = await policies.preVfs({
      call: callOf('read'),
      path: path('/data/x'),
      write: false,
      prefix: '/data/',
    })
    expect(deny).toEqual({ kind: 'deny', reason: 'no reads', policy: 'DenyReadOps' })
    expect(
      await policies.preVfs({
        call: callOf('write'),
        path: path('/data/x'),
        write: true,
        prefix: '/data/',
      }),
    ).toBeNull()
  })

  it('preVfsGate throws PolicyDenied with the EACCES stamp', async () => {
    const policies = new Policies()
    policies.add(new DenyReadOps())
    await expect(
      preVfsGate(policies, callOf('read'), path('/data/x'), false, '/data/'),
    ).rejects.toThrow(PolicyDenied)
    try {
      await preVfsGate(policies, callOf('read'), path('/data/x'), false, '/data/')
    } catch (err) {
      expect((err as PolicyDenied).code).toBe('EACCES')
      expect((err as PolicyDenied).virtualPath).toBe('/data/x')
      expect((err as PolicyDenied).message).toBe('Permission denied')
      expect((err as PolicyDenied).refusal?.reason).toBe('no reads')
    }
    // No opinion on writes: the gate passes silently.
    await preVfsGate(policies, callOf('write'), path('/data/x'), true, '/data/')
  })

  it('postVfsGate suppresses the result', async () => {
    const policies = new Policies()
    policies.add(new DenyBigResults())
    await postVfsGate(policies, callOf('read'), path('/data/x'), false, '/data/', new Uint8Array(4))
    await expect(
      postVfsGate(policies, callOf('read'), path('/data/x'), false, '/data/', new Uint8Array(64)),
    ).rejects.toMatchObject({ refusal: { reason: 'result too large' } })
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
  it('a postVfs deny suppresses a capacity reply', async () => {
    // A file call outside a line meets postVfs; a command's own call is
    // the line's, which postCommand and postExecute judge.
    const ws = executableWorkspace()
    try {
      await ws.shell('touch /data/f')
      ws.policies.add(new SuppressCapacity())
      await expect(ws.dispatch('statfs', '/data/f')).rejects.toThrow(PolicyDenied)
      const result = await ws.shell('stat -f -c %b /data/f')
      expect(result.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('guards refuse before backend I/O and leave other paths open', async () => {
    const ws = executableWorkspace([
      {
        reason: 'production data is protected',
        commands: ['rm'],
        paths: ['/data/prod/*'],
      },
    ])
    try {
      await ws.shell('mkdir -p /data/prod && echo keep > /data/prod/x.txt')
      const refused = await ws.shell('rm /data/prod/x.txt')
      expect(refused.exitCode).toBe(1)
      expect(new TextDecoder().decode(refused.stderr)).toBe(
        "rm: cannot remove '/data/prod/x.txt': Permission denied\n",
      )
      const intact = await ws.shell('cat /data/prod/x.txt')
      expect(new TextDecoder().decode(intact.stdout)).toBe('keep\n')
    } finally {
      await ws.close()
    }
  })

  it('ws.policies.add wins over runtime placement', async () => {
    // python3 is runtime-bound in the default world; the preCommand
    // method fires ahead of runtime resolution, so the refusal wins.
    const ws = executableWorkspace()
    try {
      ws.policies.add(new NoInterpreters())
      const refused = await ws.shell("python3 -c 'print(1)'")
      // A whole-command refusal is bash's "found but may not run".
      expect(refused.exitCode).toBe(126)
      expect(new TextDecoder().decode(refused.stderr)).toBe('python3: Permission denied\n')
      expect(refused.refusal).toEqual({
        kind: 'deny',
        reason: 'interpreters are off',
        policy: 'NoInterpreters',
        askId: null,
      })
    } finally {
      await ws.close()
    }
  })

  it('the policies option accepts instances', async () => {
    const ws = executableWorkspace(undefined, [new NoInterpreters()])
    try {
      const refused = await ws.shell("python3 -c 'print(1)'")
      expect(refused.exitCode).toBe(126)
      expect(new TextDecoder().decode(refused.stderr)).toBe('python3: Permission denied\n')
      expect(refused.refusal).toEqual({
        kind: 'deny',
        reason: 'interpreters are off',
        policy: 'NoInterpreters',
        askId: null,
      })
    } finally {
      await ws.close()
    }
  })

  it('guards cover shell builtins and namespace routes', async () => {
    // source is a dispatch-level shell builtin and touch is
    // namespace-routed; neither reaches handleCommand, so this pins
    // the method at the dispatch chokepoint.
    const ws = executableWorkspace([
      { reason: 'disabled', commands: ['source'] },
      { reason: 'frozen', commands: ['touch'], paths: ['/data/prod/*'] },
    ])
    try {
      const refused = await ws.shell('source /data/setup.sh')
      expect(refused.exitCode).toBe(126)
      expect(new TextDecoder().decode(refused.stderr)).toBe('source: Permission denied\n')
      expect(refused.refusal).toEqual({
        kind: 'deny',
        reason: 'disabled',
        policy: 'PermissionsPolicy',
        askId: null,
      })
      const frozen = await ws.shell('touch /data/prod/x')
      expect(frozen.exitCode).toBe(1)
      expect(new TextDecoder().decode(frozen.stderr)).toBe(
        "touch: cannot touch '/data/prod/x': Permission denied\n",
      )
      expect(frozen.refusal?.reason).toBe('frozen')
      const ok = await ws.shell('touch /data/dev-x && echo done')
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
      await ws.shell('mkdir -p /data/prod')
      const refused = await ws.shell('shuf -e a -o /data/prod/out')
      expect(refused.exitCode).toBe(1)
      expect(refused.refusal?.reason).toBe('prod is protected')
      const listing = await ws.shell('ls /data/prod')
      expect(new TextDecoder().decode(listing.stdout)).not.toContain('out')
    } finally {
      await ws.close()
    }
  })

  it('path guards hold at the programmatic entry point', async () => {
    // ws.dispatch is the one TS dispatcher (FUSE routes through it); a
    // path-only guard must refuse it, not just shell commands (#675).
    const ws = executableWorkspace([{ reason: 'prod is protected', paths: ['/data/prod/*'] }])
    try {
      await ws.shell('mkdir -p /data/other')
      await ws.dispatch('write', '/data/other/ok.txt', [new TextEncoder().encode('fine')])
      await expect(
        ws.dispatch('write', '/data/prod/x.txt', [new TextEncoder().encode('nope')]),
      ).rejects.toThrow(PolicyDenied)
      await expect(ws.dispatch('read', '/data/prod/x.txt')).rejects.toMatchObject({
        refusal: { reason: 'prod is protected' },
      })
    } finally {
      await ws.close()
    }
  })

  it('touch on an existing file is a write at the dispatcher', async () => {
    // touch on an existing file mutates via setattr, not create; the
    // write classification must cover that op too, so the mount's mode
    // refuses it.
    const ram = new RAMVFS()
    const seed = new Workspace({ '/data/': ram }, { mode: MountMode.WRITE, shellParser: parser })
    await seed.shell('mkdir -p /data/prod && echo keep > /data/prod/x.txt')
    const ws = new Workspace({ '/data/': ram }, { mode: MountMode.READ, shellParser: parser })
    try {
      const refused = await ws.shell('touch /data/prod/x.txt')
      expect(refused.exitCode).not.toBe(0)
      expect(new TextDecoder().decode(refused.stderr)).toContain('Read-only file system')
    } finally {
      await ws.close()
      await seed.close()
    }
  })
})

class CapFour implements Policy {
  postVfs(_ctx: VfsResultContext): Action | null {
    return new Limit({ maxBytes: 4 })
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
  const opsCtx = (): VfsResultContext => ({
    call: callOf('read'),
    path: path('/data/x'),
    write: false,
    prefix: '/data/',
    result: new TextEncoder().encode('payload'),
  })

  it('a limit is illegal on postVfs', async () => {
    const policies = new Policies()
    policies.add(new CapFour())
    await expect(policies.postVfs(opsCtx())).rejects.toThrow(/CapFour/)
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
      line: 'echo',
      commands: [],
      sessionId: '',
      producer: { command: 'echo', prefixes: [], declared: null },
      exitCode: 0,
      output: new Uint8Array(),
      results: {},
    })
    expect(deny).toBeNull()
    expect(bound?.maxLines).toBe(2)
  })

  it('a user limit policy caps line output', async () => {
    const ws = executableWorkspace()
    try {
      ws.policies.add(new CapLines())
      await ws.dispatch('write', '/data/big.txt', [new TextEncoder().encode('1\n2\n3\n4\n5\n')])
      const r = await ws.shell('cat /data/big.txt')
      const out = new TextDecoder().decode(r.stdout)
      expect(out.split('\n').filter((l) => l !== '').length).toBe(2)
      expect(new TextDecoder().decode(r.stderr)).toContain('output truncated')
    } finally {
      await ws.close()
    }
  })

  it('a postVfs limit fails the call: a file call is never cut', async () => {
    const ws = executableWorkspace()
    try {
      await ws.dispatch('write', '/data/f.txt', [new TextEncoder().encode('hello world')])
      ws.policies.add(new CapFour())
      await expect(ws.dispatch('read', '/data/f.txt')).rejects.toThrow(/CapFour/)
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

class SeeProducer implements Policy {
  readonly seen: string[] = []
  postExecute(ctx: ExecuteResultContext): Action | null {
    this.seen.push(ctx.producer.command)
    return null
  }
}

describe('Limit end to end', () => {
  it.each([
    {
      name: 'truncate',
      policy: CapLines,
      command: "printf '1\\n2\\n3\\n'; echo fourth",
      stdout: '1\n2\n',
      stderr: 'output truncated',
      exitCode: 0,
      failed: false,
    },
    {
      name: 'hard limit',
      policy: CapBytesHard,
      command: 'echo secret; echo more',
      stdout: '',
      stderr: 'output truncated',
      exitCode: 1,
      failed: false,
    },
    {
      name: 'failed policy',
      policy: Boom,
      command: 'echo secret; echo forbidden >&2',
      stdout: '',
      stderr: 'forbidden\necho: Permission denied\n',
      exitCode: 126,
      failed: true,
    },
  ])('stream exposes only approved output: $name', async (test) => {
    const ws = executableWorkspace()
    try {
      ws.policies.add(new test.policy())
      const execution = await ws.shell(test.command, { stream: true })
      const output = { stdout: '', stderr: '' }
      try {
        for await (const event of execution.events)
          output[event.stream] += new TextDecoder().decode(event.data)
        const result = await execution.wait()
        expect(output.stdout).toBe(test.stdout)
        expect(output.stderr).toContain(test.stderr)
        expect(result.exitCode).toBe(test.exitCode)
        expect(result.stdout.byteLength).toBe(0)
        expect(result.stderr.byteLength).toBe(0)
        if (test.failed) {
          expect(output.stderr).toBe(test.stderr)
          expect(result.refusal).toMatchObject({
            kind: 'failed',
            reason: 'Boom failed',
            policy: 'Boom',
          })
        } else expect(result.refusal).toBeNull()
      } finally {
        await execution.close()
      }
    } finally {
      await ws.close()
    }
  })

  it('two limit policies merge to the tightest', async () => {
    const ws = executableWorkspace()
    try {
      ws.policies.add(new CapLines())
      ws.policies.add(new CapThree())
      await ws.dispatch('write', '/data/big.txt', [new TextEncoder().encode('1\n2\n3\n4\n5\n')])
      const r = await ws.shell('cat /data/big.txt')
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
      const r = await ws.shell('cat /data/f.txt')
      expect(r.exitCode).toBe(1)
      expect(new TextDecoder().decode(r.stderr)).toContain('output truncated')
      const ok = await ws.shell('echo ok')
      expect(ok.exitCode).toBe(0)
      expect(new TextDecoder().decode(ok.stdout)).toBe('ok\n')
    } finally {
      await ws.close()
    }
  })

  it('a throwing postExecute policy fails the line closed', async () => {
    const ws = executableWorkspace()
    try {
      ws.policies.add(new Boom())
      const r = await ws.shell('echo hi')
      expect(r.exitCode).toBe(126)
      const err = new TextDecoder().decode(r.stderr)
      expect(err).toBe('echo: Permission denied\n')
      expect(r.refusal).toEqual({
        kind: 'failed',
        reason: 'Boom failed',
        policy: 'Boom',
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
      await ws.shell('cat /data/f.txt | wc -l')
      await ws.shell('cat /data/f.txt ; head -n 1 /data/f.txt')
      await ws.shell('false || cat /data/f.txt')
      // Builtins carry provenance too: a policy keyed on echo sees it.
      await ws.shell('echo hi')
      await ws.shell('cat /data/f.txt ; echo done')
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
    // With nothing refusing, every Ask is the answer: the first one's
    // voice, with each policy's rule for the host to grant.
    const policies = new Policies([new AskRm(), new AskAll()])
    expect(await policies.preCommand(ctx('rm'))).toEqual({
      kind: 'ask',
      reason: 'sign-off',
      policy: 'AskRm',
      rules: [
        { reason: 'sign-off', commands: ['rm'] },
        { reason: 'second opinion', commands: ['rm'] },
      ],
    })
    expect(await policies.preCommand(ctx('ls'))).toEqual({
      kind: 'ask',
      reason: 'second opinion',
      policy: 'AskAll',
    })
  })

  it('an op ask with no ledger refuses like a deny', async () => {
    // An entry point that cannot put the question (no ledger) refuses it, in the
    // deny voice, with the reason on the record.
    const policies = new Policies([new AskOnOps()])
    const refused = await preVfsGate(
      policies,
      callOf('write'),
      path('/data/x'),
      true,
      '/data/',
    ).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(PolicyDenied)
    expect((refused as PolicyDenied).refusal?.kind).toBe('deny')
  })

  it('preExecute routes agree and an ask holds the line', async () => {
    class OnBeta implements Policy {
      preExecute(): Route {
        return { kind: 'route', runtime: 'beta' }
      }
    }
    class AskToPlace implements Policy {
      preExecute(): Ask {
        return { kind: 'ask', reason: 'where?' }
      }
    }
    const line: RouteContext = {
      line: 'python3 x',
      commands: [],
      sessionId: '',
    }
    // Two policies naming one runtime agree; the first names the line.
    expect(await new Policies([new OnBeta(), new OnBeta()]).preExecute(line)).toEqual([
      null,
      { kind: 'route', runtime: 'beta', policy: 'OnBeta' },
    ])
    // An Ask comes back beside the Route, for the entry point to put.
    expect(await new Policies([new AskToPlace(), new OnBeta()]).preExecute(line)).toEqual([
      { kind: 'ask', reason: 'where?', policy: 'AskToPlace' },
      { kind: 'route', runtime: 'beta', policy: 'OnBeta' },
    ])
  })

  it('renderDeny words an open question as a deny', () => {
    const [err, code] = renderDeny('git', { kind: 'pending', id: 'abc123', reason: 'sign-off' })
    expect(new TextDecoder().decode(err)).toBe('git: Permission denied\n')
    expect(code).toBe(126)
  })

  it('refusalOf records kind, policy and ask', () => {
    expect(refusalOf({ kind: 'deny', reason: 'user rule', policy: 'RulePolicy' })).toEqual({
      kind: 'deny',
      reason: 'user rule',
      policy: 'RulePolicy',
      askId: null,
    })
    // The filesystem's own error is no policy refusal: nothing recorded.
    expect(
      refusalOf({
        kind: 'deny',
        reason: "cannot remove 'x'",
        policy: 'MountRootPolicy',
        error: ebusy('/x'),
      }),
    ).toBeNull()
    expect(
      refusalOf({ kind: 'deny', reason: 'Raising failed', policy: 'Raising', failed: true }),
    ).toEqual({
      kind: 'failed',
      reason: 'Raising failed',
      policy: 'Raising',
      askId: null,
    })
    expect(refusalOf({ kind: 'pending', id: 'abc123', reason: 'sign-off' })).toEqual({
      kind: 'pending',
      reason: 'sign-off',
      policy: '',
      askId: 'abc123',
    })
  })

  it('describeRefusal carries the reason the stderr line dropped', () => {
    expect(
      describeRefusal({
        kind: 'deny',
        reason: 'user rule',
        policy: 'RulePolicy',
        askId: null,
      }),
    ).toBe('policy denied: user rule')
    expect(
      describeRefusal({
        kind: 'pending',
        reason: 'sign-off',
        policy: '',
        askId: 'abc123',
      }),
    ).toBe('requires approval: sign-off (ask abc123)')
    expect(
      describeRefusal({
        kind: 'failed',
        reason: 'Raising failed',
        policy: 'Raising',
        askId: null,
      }),
    ).toBe('policy Raising failed')
  })
})

it('removes by identity, refreshes methods and preserves an admission in progress', async () => {
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

describe('the op-policies binding', () => {
  it('is scoped to one command', async () => {
    expect(getOpPolicies()).toBeNull()
    const policies = new Policies([])
    await runWithOpPolicies(policies, () => {
      expect(getOpPolicies()).toBe(policies)
      return Promise.resolve()
    })
    expect(getOpPolicies()).toBeNull()
  })
})

async function askedRounds(ws: Workspace, line: string, count: number): Promise<string[][]> {
  const asked: string[][] = []
  for (let i = 0; i < count; i++) {
    const held = await ws.shell(line)
    expect(held.refusal?.kind).toBe('pending')
    const records = ws.decisions.pending()
    asked.push(records.map((r) => [r.reason, ...r.argv].join(' ')).sort())
    for (const record of records) await ws.decisions.answer(record.id, Outcome.ALLOW)
  }
  return asked
}

describe('every method answers Deny and Ask', () => {
  class AskSecrets implements Policy {
    preSession(ctx: SessionContext): Action | null {
      return ctx.key.startsWith('SECRET') ? { kind: 'ask', reason: 'secret write' } : null
    }
  }

  it('a preSession ask a host answers inline writes', async () => {
    const asked: Decision[] = []
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      {
        shellParser: parser,
        policies: [new AskSecrets()],
        onAsk: (record: Decision) => {
          asked.push(record)
          return Promise.resolve({ ...record, outcome: Outcome.ALLOW })
        },
      },
    )
    try {
      expect((await ws.shell('export SECRET_A=1')).exitCode).toBe(0)
      expect((await ws.shell('echo $SECRET_A')).stdoutText).toBe('1\n')
      expect(asked.map((r) => r.argv)).toEqual([['SECRET_A', '1']])
    } finally {
      await ws.close()
    }
  })

  class AskAround implements Policy {
    preSession(): Action | null {
      return { kind: 'ask', reason: 'before' }
    }

    postSession(): Action | null {
      return { kind: 'ask', reason: 'after' }
    }
  }

  it.each(['export B=1', 'B=1 true', '{ export B=1; } & wait'])(
    'a write asked before and after asks each once: %s',
    async (line) => {
      // The nod to the first question stands while the second waits.
      const ws = executableWorkspace(undefined, [new AskAround()])
      try {
        expect(await askedRounds(ws, line, 2)).toEqual([['before B 1'], ['after B 1']])
        expect((await ws.shell(line)).exitCode).toBe(0)
      } finally {
        await ws.close()
      }
    },
  )

  it('the writes of a line are spent when it ends', async () => {
    // A retry finds the nods for the writes before the one it waits on.
    const ws = executableWorkspace(undefined, [new AskAround()])
    try {
      const line = 'B=1 true; export C=2'
      expect(await askedRounds(ws, line, 2)).toEqual([
        ['before B 1', 'before C 2'],
        ['after B 1', 'after C 2'],
      ])
      expect((await ws.shell(line)).exitCode).toBe(0)
      expect(await askedRounds(ws, line, 1)).toEqual([['before B 1', 'before C 2']])
    } finally {
      await ws.close()
    }
  })

  class AskReads implements Policy {
    readonly seen: [VfsContext, VfsResultContext][] = []
    private readonly pre: VfsContext[] = []

    preVfs(ctx: VfsContext): Action | null {
      this.pre.push(ctx)
      return null
    }

    postVfs(ctx: VfsResultContext): Action | null {
      const pre = this.pre.at(-1)
      if (pre !== undefined) this.seen.push([pre, ctx])
      return ctx.call.name === 'read' ? { kind: 'ask', reason: 'read sign-off' } : null
    }
  }

  it('a postVfs ask holds the result back until approved', async () => {
    // The call ran; what came back waits on the host, and the approved
    // retry runs it again. The method saw what preVfs saw.
    const policy = new AskReads()
    const ws = executableWorkspace()
    try {
      await ws.shell('echo x > /data/x')
      ws.policies.add(policy)
      const refused = await ws.vfs.read('/data/x').catch((err: unknown) => err)
      expect(refused).toBeInstanceOf(PolicyDenied)
      const refusal = (refused as PolicyDenied).refusal
      expect(refusal?.kind).toBe('pending')
      const last = policy.seen.at(-1)
      expect(last).toBeDefined()
      const [pre, post] = last ?? []
      for (const field of ['call', 'path', 'write', 'prefix', 'sessionId', 'mode'] as const) {
        expect(post?.[field]).toEqual(pre?.[field])
      }
      expect(new TextDecoder().decode(post?.result as Uint8Array)).toBe('x\n')
      await ws.decisions.answer(refusal?.askId ?? '', Outcome.ALLOW)
      expect(new TextDecoder().decode(await ws.vfs.read('/data/x'))).toBe('x\n')
    } finally {
      await ws.close()
    }
  })

  class AskRemovals implements Policy {
    preCommand(ctx: CommandContext): Action | null {
      return ctx.command === 'rm' ? { kind: 'ask', reason: 'removal' } : null
    }
  }

  class AskEverything implements Policy {
    preCommand(): Action | null {
      return { kind: 'ask', reason: 'anything' }
    }
  }

  it('every ask in a chain is put to the host', async () => {
    // Two policies ask about one command: the host approves each, one
    // question at a time, and the command runs once both are approved.
    const ws = executableWorkspace(undefined, [new AskRemovals(), new AskEverything()])
    try {
      const reasons: string[] = []
      for (let i = 0; i < 2; i++) {
        const held = await ws.shell('rm -f /data/x')
        expect(held.refusal?.kind).toBe('pending')
        const pending = ws.decisions.pending()
        expect(pending).toHaveLength(1)
        const [record] = pending
        reasons.push(record?.reason ?? '')
        await ws.decisions.answer(record?.id ?? '', Outcome.ALLOW)
      }
      expect(reasons).toEqual(['removal', 'anything'])
      expect((await ws.shell('rm -f /data/x')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })
})

describe('postCommand and postSession', () => {
  class AfterCommands implements Policy {
    readonly seen: CommandResultContext[] = []

    postCommand(ctx: CommandResultContext): Action | null {
      this.seen.push(ctx)
      return null
    }
  }

  it('postCommand sees each command once with its result', async () => {
    // Once per command, after it ran: the exit code is final even for a
    // command whose status settles as its output drains (grep).
    const policy = new AfterCommands()
    const ws = executableWorkspace()
    try {
      await ws.shell('echo hit > /data/x')
      ws.policies.add(policy)
      await ws.shell('grep miss /data/x; cat /data/none')
      expect(policy.seen.map((c) => [c.command, c.exitCode])).toEqual([
        ['grep', 1],
        ['cat', 1],
      ])
      expect(policy.seen[1]?.stderr).toContain('No such file or directory')
    } finally {
      await ws.close()
    }
  })

  class NoVaultShown implements Policy {
    postCommand(ctx: CommandResultContext): Action | null {
      const vault = ctx.records.some(
        (r) => typeof r.path === 'string' && r.path.startsWith('/data/vault/'),
      )
      return vault ? { kind: 'deny', reason: 'vault reads need an operator' } : null
    }
  }

  it('postCommand reads the files its command read', async () => {
    // cat reads as its output is pulled, after it returned: the records are
    // its own all the same, and the command reading them is not charged
    // with them.
    const ws = executableWorkspace()
    try {
      await ws.shell('mkdir -p /data/vault && echo k > /data/vault/k')
      ws.policies.add(new NoVaultShown())
      const out = await ws.shell('cat /data/vault/k && echo next')
      expect([out.exitCode, out.stdoutText]).toEqual([126, 'k\n'])
      const piped = await ws.shell('cat /data/vault/k | cat')
      expect([piped.exitCode, piped.stderrText]).toEqual([0, 'cat: Permission denied\n'])
    } finally {
      await ws.close()
    }
  })

  class GuardVars implements Policy {
    readonly seen: SessionResultContext[] = []

    postSession(ctx: SessionResultContext): Action | null {
      this.seen.push(ctx)
      if (ctx.key !== 'A') return null
      if (ctx.value === '2' || ctx.verb === 'unset') return { kind: 'deny', reason: 'frozen' }
      return null
    }
  }

  it('a postSession deny puts the old value back', async () => {
    const policy = new GuardVars()
    const ws = executableWorkspace(undefined, [policy])
    try {
      expect((await ws.shell('export A=1')).exitCode).toBe(0)
      expect(policy.seen.at(-1)?.old).toBeNull()
      expect((await ws.shell('export A=2')).exitCode).toBe(1)
      expect(policy.seen.at(-1)?.old).toBe('1')
      expect((await ws.shell('echo $A')).stdoutText).toBe('1\n')
      expect((await ws.shell('unset A')).exitCode).toBe(1)
      expect((await ws.shell('echo $A')).stdoutText).toBe('1\n')
    } finally {
      await ws.close()
    }
  })
})

describe('what a method sees', () => {
  class ReadsAround implements Policy {
    readonly seen: [string, string | null, string, boolean][] = []
    readonly refused: string[] = []

    async preCommand(ctx: CommandContext): Promise<Action | null> {
      if (ctx.command !== 'echo') return null
      const { session, ns, vfs } = ctx
      if (session === undefined || ns?.mounts === undefined || vfs === undefined) {
        throw new Error('a method was asked without its handles')
      }
      this.seen.push([
        session.cwd(),
        session.get('TEAM'),
        new TextDecoder().decode(await vfs.read('/data/owner.txt')),
        ns.mounts.isRoot('/data'),
      ])
      for (const write of [
        () => vfs.write('/data/owner.txt', 'me\n'),
        () => session.set('TEAM', 'me'),
      ]) {
        try {
          await write()
        } catch (err) {
          this.refused.push((err as { code?: string }).code ?? '')
        }
      }
      return null
    }
  }

  class OpRecorder implements Policy {
    readonly asked: string[] = []

    preVfs(ctx: VfsContext): Action | null {
      this.asked.push(ctx.path.virtual)
      return null
    }
  }

  it('reads the session and its files and writes nothing', async () => {
    const reader = new ReadsAround()
    const recorder = new OpRecorder()
    const ws = executableWorkspace(undefined, [reader, recorder])
    try {
      await ws.vfs.write('/data/owner.txt', 'core\n')
      await ws.shell('cd /data; export TEAM=core')
      recorder.asked.length = 0
      expect((await ws.shell('echo hi')).stdoutText).toBe('hi\n')
      expect(reader.seen).toEqual([['/data', 'core', 'core\n', true]])
      expect(reader.refused).toEqual(['EROFS', 'EACCES'])
      // The method's own read is judged by the rules alone: no user preVfs
      // runs again for it.
      expect(recorder.asked).toEqual([])
      expect(new TextDecoder().decode(await ws.vfs.read('/data/owner.txt'))).toBe('core\n')
      expect((await ws.shell('echo $TEAM')).stdoutText).toBe('core\n')
      // explain walks the `cd` on a copy, and the method reads that copy.
      await ws.explain('cd /; echo hi')
      expect(reader.seen.at(-1)?.[0]).toBe('/')
    } finally {
      await ws.close()
    }
  })

  class SeeLine implements Policy {
    readonly seen: ExecuteResultContext[] = []

    postExecute(ctx: ExecuteResultContext): Action | null {
      this.seen.push(ctx)
      return null
    }
  }

  it('postExecute sees the line, its output and each result', async () => {
    // A function hands back its last command's node, and grep's status
    // settles as its output drains: each node keeps its read and status.
    const spy = new SeeLine()
    const ws = executableWorkspace(undefined, [spy])
    try {
      await ws.shell('cd /data; echo hi | cat; false')
      const ctx = spy.seen.at(-1)
      expect(ctx?.line).toBe('cd /data; echo hi | cat; false')
      expect(ctx?.commands.map((c) => c.command)).toEqual(['cd', 'echo', 'cat', 'false'])
      expect(new TextDecoder().decode(ctx?.output)).toBe('hi\n')
      expect(ctx?.exitCode).toBe(1)
      expect(ctx?.session?.cwd()).toBe('/data')
      const ran = leaves(ctx?.results ?? {})
      expect(ran.map(([name]) => name.split(' ')[0])).toEqual(['cd', 'echo', 'cat', 'false'])
      expect(ran.at(-1)?.[1]).toBe(1)
      await ws.shell('echo hit > /data/x')
      await ws.shell('f() { cat /data/x; }; f')
      expect(recordPaths(spy.seen.at(-1)?.results ?? {})).toContain('/data/x')
      await ws.shell('grep hit /data/x; true')
      const [grep] = (spy.seen.at(-1)?.results.children ?? []) as Record<string, unknown>[]
      expect(grep?.exitCode).toBe(0)
      const records = (grep?.records ?? []) as Record<string, unknown>[]
      expect(records.map((r) => r.path)).toEqual(['/data/x'])
    } finally {
      await ws.close()
    }
  })

  class SeeRoute implements Policy {
    readonly seen: [string, string, string | undefined][][] = []

    preExecute(ctx: RouteContext): Action | null {
      this.seen.push(ctx.commands.map((c) => [c.command, c.cwd, c.session?.cwd()]))
      return null
    }
  }

  it('preExecute shows a nested command in the session it runs in', async () => {
    // eval's line runs after its own cd: the command in it stands in
    // /data, while eval itself stands where the line was typed.
    const spy = new SeeRoute()
    const ws = executableWorkspace(undefined, [spy])
    try {
      await ws.shell("eval 'cd /data; cat x'")
      expect(spy.seen.at(-1)).toEqual([
        ['eval', '/', '/'],
        ['cd', '/', '/'],
        ['cat', '/data', '/data'],
      ])
    } finally {
      await ws.close()
    }
  })

  it('a route policy reads the session as data', async () => {
    const seen: Record<string, unknown>[] = []
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        routePolicy: (ctx: RouteContext) => {
          seen.push(scriptContext(ctx))
          return null
        },
      },
    )
    try {
      await ws.shell('cd /data; export TEAM=core')
      await ws.shell('echo hi')
      const payload = seen.at(-1) as { cwd: string; env: Record<string, string> }
      expect(payload.cwd).toBe('/data')
      expect(payload.env.TEAM).toBe('core')
      expect(seen.at(-1)?.mounts).toContain('/data')
    } finally {
      await ws.close()
    }
  })
})
