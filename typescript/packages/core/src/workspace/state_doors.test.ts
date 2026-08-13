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

import { afterEach, describe, expect, it } from 'vitest'
import { RegisteredCommand } from '../commands/config.ts'
import { CommandSpec, Operand } from '../commands/spec/types.ts'
import { runWithSession } from '../context/session_context.ts'
import { IOResult } from '../io/types.ts'
import { OpsRegistry, type RegisteredOp } from '../ops/registry.ts'
import type { Action, OpsContext, Policy, SessionContext } from '../policy/index.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode, ResourceName } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()

/** Refuse one op name outright, whatever path asked. */
class DenyOp implements Policy {
  private readonly op: string
  constructor(op: string) {
    this.op = op
  }
  preOps(ctx: OpsContext): Action | null {
    if (ctx.op === this.op) return { kind: 'deny', message: `${this.op} refused by policy\n` }
    return null
  }
}

// Ops resolve by resource kind in the workspace registry, so an
// overlay-backend simulation blocks registration itself.
class NoSetattrRegistry extends OpsRegistry {
  override register(ro: RegisteredOp): void {
    if (ro.name === 'setattr') return
    super.register(ro)
  }
}

const open: Workspace[] = []

async function makeWs(policies?: Policy[]): Promise<Workspace> {
  const parser = await getTestParser()
  const a = new RAMResource()
  a.store.files.set('/x.txt', ENC.encode('public\n'))
  const b = new RAMResource()
  b.store.files.set('/y.txt', ENC.encode('other\n'))
  const ws = new Workspace(
    { '/a': a, '/b': b },
    { mode: MountMode.WRITE, shellParser: parser, ...(policies !== undefined ? { policies } : {}) },
  )
  open.push(ws)
  return ws
}

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

describe('name-plane writes go through the door', () => {
  it('ln fires the op gates', async () => {
    const ws = await makeWs([new DenyOp('symlink')])
    const io = await ws.execute('ln -s x.txt /a/lk')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('Permission denied')
    expect(ws.namespace.isLink('/a/lk')).toBe(false)
  })

  it('ln leaves an op record', async () => {
    // The op ledger must not say a workspace with ln traffic did
    // nothing: the door records the namespace write like any other op.
    const ws = await makeWs()
    const io = await ws.execute('ln -s x.txt /a/lk')
    expect(io.exitCode).toBe(0)
    expect(ws.records.some((r) => r.op === 'symlink' && r.path === '/a/lk')).toBe(true)
  })

  it('scoped shell ln onto ungranted turf is refused', async () => {
    const ws = await makeWs()
    ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    const io = await ws.execute('ln -s /a/x.txt /b/lk', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.namespace.isLink('/b/lk')).toBe(false)
  })

  it('symlink and readlink answer on the fs facade', async () => {
    // readlink is the read twin: guests and CLIs ask through the same
    // door instead of a bespoke channel.
    const ws = await makeWs()
    await ws.fs.symlink('/a/lk', 'x.txt')
    expect(await ws.fs.readlink('/a/lk')).toBe('x.txt')
    expect(ws.namespace.readlink('/a/lk')).toBe('x.txt')
  })

  it('readlink on a non-link reports EINVAL', async () => {
    const ws = await makeWs()
    await expect(ws.fs.readlink('/a/x.txt')).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('facade symlink respects session grants', async () => {
    const ws = await makeWs()
    const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    await runWithSession(sess, async () => {
      await ws.fs.symlink('/a/lk', 'x.txt')
      await expect(ws.fs.symlink('/b/lk', 'y.txt')).rejects.toThrow('not allowed')
    })
    expect(ws.namespace.isLink('/a/lk')).toBe(true)
    expect(ws.namespace.isLink('/b/lk')).toBe(false)
  })

  it('chown -h on a link fires the op gates', async () => {
    // chown -h writes the link's own attrs; that overlay write used to
    // bypass the door entirely, so no policy could bound it.
    const ws = await makeWs([new DenyOp('setattr')])
    const made = await ws.execute('ln -s x.txt /a/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.execute('chown -h alice /a/lk')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    expect(ws.namespace.metaFor('/a/lk')?.uid).toBeUndefined()
  })

  it('overlay setattr fires the op gates', async () => {
    // A backend with no native setattr op stores attrs in the namespace
    // overlay; that write must clear the same gates as a native one.
    const parser = await getTestParser()
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', ENC.encode('body\n'))
    const ws = new Workspace(
      { '/o': resource },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        ops: new NoSetattrRegistry(),
        policies: [new DenyOp('setattr')],
      },
    )
    open.push(ws)
    const io = await ws.execute('chmod 600 /o/f.txt')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    expect(ws.namespace.metaFor('/o/f.txt')?.mode).toBeUndefined()
  })

  it('overlay setattr still lands without policies', async () => {
    const parser = await getTestParser()
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', ENC.encode('body\n'))
    const ws = new Workspace(
      { '/o': resource },
      { mode: MountMode.WRITE, shellParser: parser, ops: new NoSetattrRegistry() },
    )
    open.push(ws)
    const io = await ws.execute('chmod 600 /o/f.txt')
    expect(io.exitCode).toBe(0)
    expect(ws.namespace.metaFor('/o/f.txt')?.mode).toBe(0o600)
  })
})

/** Veto env writes to SECRET_* names through the session view. */
class DenySecretEnv implements Policy {
  preSession(ctx: SessionContext): Action | null {
    if (ctx.plane === 'env' && ctx.key.startsWith('SECRET')) {
      return { kind: 'deny', message: 'SECRET_* refused by policy\n' }
    }
    return null
  }
}

const CMD_SPEC = new CommandSpec({ rest: new Operand({ type: 'path' }) })

describe('session-state writes go through the view', () => {
  it('export fires the state gate', async () => {
    // The session plane's gate: an env write clears preSession exactly
    // as a VFS write clears preOps, whichever tier asked.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.execute('export SECRET_X=1')
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('refused by policy')
    expect('SECRET_X' in ws.env).toBe(false)
    const allowed = await ws.execute('export PUBLIC_X=1')
    expect(allowed.exitCode).toBe(0)
    expect(ws.env.PUBLIC_X).toBe('1')
  })

  it('command env is a snapshot, not the live dict', async () => {
    // A command's env is the process view: a child cannot write the
    // parent's environment, so a mutation must not land in the session.
    const ws = await makeWs()
    const rc = new RegisteredCommand({
      name: 'envpoke',
      spec: CMD_SPEC,
      resource: ResourceName.RAM,
      fn: (_accessor, _paths, _texts, opts) => {
        expect(opts.env).toBeDefined()
        if (opts.env !== undefined) opts.env.INJECTED = '1'
        return [new Uint8Array(), new IOResult()]
      },
    })
    ws.registry.mountForPrefix('/a')?.register(rc)
    const io = await ws.execute('envpoke /a/x.txt')
    expect(io.exitCode).toBe(0)
    expect('INJECTED' in ws.env).toBe(false)
  })

  it('a command can opt into the session view', async () => {
    // The LinkView pattern for the session plane: reading `sessionView`
    // off the opts is the whole opt-in, and reads answer through it.
    const ws = await makeWs()
    const rc = new RegisteredCommand({
      name: 'envread',
      spec: CMD_SPEC,
      resource: ResourceName.RAM,
      fn: (_accessor, _paths, _texts, opts) => {
        const value = opts.sessionView?.get('MARKER') ?? 'none'
        return [ENC.encode(value), new IOResult()]
      },
    })
    ws.registry.mountForPrefix('/a')?.register(rc)
    await ws.execute('export MARKER=yes')
    const io = await ws.execute('envread /a/x.txt')
    expect(stdoutStr(io).trim()).toBe('yes')
  })
})

describe('the remaining session writers clear the same gate', () => {
  it('bare export of a new name fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.execute('export SECRET_BARE')
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('refused by policy')
    expect('SECRET_BARE' in ws.env).toBe(false)
    const allowed = await ws.execute('export PUBLIC_BARE')
    expect(allowed.exitCode).toBe(0)
    expect(ws.env.PUBLIC_BARE).toBe('')
  })

  it('local fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('f() { local SECRET_L=1; }; f')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    expect('SECRET_L' in ws.env).toBe(false)
  })

  it('a plain assignment fires the gate', async () => {
    // The assignment path used to write session.env directly, so a
    // policy that vetoed `export SECRET_X=1` still admitted
    // `SECRET_X=1`. Denial mirrors the readonly case: a fatal
    // variable-assignment error that abandons the rest of the line.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.execute('SECRET_P=1; echo after')
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('refused by policy')
    expect('SECRET_P' in ws.env).toBe(false)
    const allowed = await ws.execute('PUBLIC_P=1')
    expect(allowed.exitCode).toBe(0)
    expect(ws.env.PUBLIC_P).toBe('1')
  })

  it('an append assignment fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('SECRET_A+=x')
    expect(io.exitCode).not.toBe(0)
    expect('SECRET_A' in ws.env).toBe(false)
  })

  it('the for-loop variable fires the gate', async () => {
    // The loop variable is a session write per iteration; a denied
    // write aborts the loop before its body runs.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.execute('for SECRET_I in a b; do echo ran; done')
    expect(denied.exitCode).not.toBe(0)
    expect(stdoutStr(denied)).not.toContain('ran')
    expect('SECRET_I' in ws.env).toBe(false)
    const allowed = await ws.execute('for PUB_I in a b; do echo ok; done')
    expect(allowed.exitCode).toBe(0)
    expect(stdoutStr(allowed).match(/ok/g)?.length).toBe(2)
  })
})
