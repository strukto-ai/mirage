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

  it('scoped shell readlink on ungranted turf is refused', async () => {
    // The read twin of the scoped-ln hole: a session granted only /a
    // must not learn /b/lk's target through the readlink builtin, which
    // used to read the node table directly instead of dispatching.
    const ws = await makeWs()
    ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    const made = await ws.execute('ln -s /b/y.txt /b/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.execute('readlink /b/lk', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('y.txt')
  })

  it('scoped shell readlink -m on ungranted turf is refused', async () => {
    // -m/-f canonicalize without any existence probe, so without the
    // gate they printed the resolved target of an ungranted link.
    const ws = await makeWs()
    ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    const made = await ws.execute('ln -s /b/y.txt /b/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.execute('readlink -m /b/lk', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('y.txt')
  })

  it('shell readlink fires the op gates', async () => {
    const ws = await makeWs([new DenyOp('readlink')])
    const made = await ws.execute('ln -s x.txt /a/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.execute('readlink /a/lk')
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('x.txt')
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
    ws.registry.mountForPrefix('/a').register(rc)
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
    ws.registry.mountForPrefix('/a').register(rc)
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

  it('an array assignment fires the gate', async () => {
    // A denied name must not be writable by switching to array syntax:
    // SECRET=(a b) lands on the same session plane as SECRET=x.
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('SECRET_V=(a b); echo after')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_V' in sess.arrays).toBe(false)
  })

  it('an array append assignment fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('SECRET_VA+=(a)')
    expect(io.exitCode).not.toBe(0)
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_VA' in sess.arrays).toBe(false)
  })

  it('a subscript assignment fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('SECRET_S[0]=x')
    expect(io.exitCode).not.toBe(0)
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_S' in sess.arrays).toBe(false)
    expect('SECRET_S' in ws.env).toBe(false)
  })

  it('a scalar append onto an existing array fires the gate', async () => {
    // SECRET+=x on a name that already holds an array appends to
    // element 0 through a branch of its own; it is still a session
    // write.
    const ws = await makeWs([new DenySecretEnv()])
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    sess.arrays.SECRET_E = ['a']
    const io = await ws.execute('SECRET_E+=x')
    expect(io.exitCode).not.toBe(0)
    expect(sess.arrays.SECRET_E).toEqual(['a'])
  })

  it('a declaration array assignment fires the gate', async () => {
    // export/declare with an array literal store through the staged
    // path, not handleExport, so the gate has to fire there too.
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('export SECRET_D=(a)')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_D' in sess.arrays).toBe(false)
  })

  it('a readonly name refuses a declaration array store', async () => {
    // The staged-array store is the builtin's own; the shell's readonly
    // rule is pre-checked there, before the door is asked.
    const ws = await makeWs()
    await ws.execute('readonly LOCKED')
    const io = await ws.execute('export LOCKED=(a)')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('readonly variable')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('LOCKED' in sess.arrays).toBe(false)
  })

  it('a readonly declaration array abandons the line', async () => {
    // GNU treats `export LOCKED=(a)` on a readonly name as a variable
    // assignment error, not a builtin failure: the rest of the line is
    // dead (status 1) and the next line runs. Pinned on bash 5.2
    // (debian:stable-slim); the scalar spelling below continues.
    const ws = await makeWs()
    await ws.execute('readonly LOCKED')
    const denied = await ws.execute('export LOCKED=(a); echo unreached')
    expect(denied.exitCode).toBe(1)
    expect(stdoutStr(denied)).toBe('')
    expect(stderrStr(denied)).toBe('bash: LOCKED: readonly variable\n')
    const after = await ws.execute('echo after')
    expect(after.exitCode).toBe(0)
  })

  it('a readonly declare array is fatal at top level', async () => {
    const ws = await makeWs()
    await ws.execute('readonly LOCKED')
    const denied = await ws.execute('declare LOCKED=(a); echo unreached')
    expect(denied.exitCode).toBe(1)
    expect(stdoutStr(denied)).toBe('')
  })

  it('a readonly scalar export refusal continues the line', async () => {
    // The asymmetry is GNU's: `export LOCKED=v` fails with 1 in the
    // builtin's voice and the same line keeps going.
    const ws = await makeWs()
    await ws.execute('readonly LOCKED')
    const io = await ws.execute('export LOCKED=v; echo rc=$?')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('rc=1\n')
  })

  it('a readonly local array refusal stays in the function', async () => {
    // `local LOCKED=(a)` on a readonly global refuses without killing
    // the function body (GNU prints the refusal and runs `echo in-f`).
    const ws = await makeWs()
    await ws.execute('readonly LOCKED')
    const io = await ws.execute('f() { local LOCKED=(a); echo in-f; }; f')
    expect(stdoutStr(io)).toContain('in-f')
    expect(stderrStr(io)).toContain('readonly variable')
  })

  it('export of an array literal prints nothing', async () => {
    // `export ARR=(x y)` used to fall through to the bare-export print
    // branch because the handler never learned arrays were on the line.
    const ws = await makeWs()
    const io = await ws.execute('export ARR=(x y)')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect(sess.arrays.ARR).toEqual(['x', 'y'])
  })

  it('a readonly loop variable refuses before the body', async () => {
    // bash refuses a readonly loop variable and never runs the body;
    // the loop writes go through the view now, same as any assignment.
    const ws = await makeWs()
    await ws.execute('readonly LV')
    const denied = await ws.execute('for LV in a b; do echo ran; done')
    expect(denied.exitCode).not.toBe(0)
    expect(stdoutStr(denied)).not.toContain('ran')
  })

  it('a subscripted unset of a scalar fires the gate', async () => {
    // `unset 'SECRET[0]'` on a scalar is the whole unset in element
    // clothing; the element branch used to skip the view entirely.
    const ws = await makeWs([new DenySecretEnv()])
    ws.env.SECRET_U = 'v'
    const io = await ws.execute("unset 'SECRET_U[0]'")
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    expect(ws.env.SECRET_U).toBe('v')
  })

  it('a subscripted unset of an array element fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    sess.arrays.SECRET_W = ['a', 'b']
    const io = await ws.execute("unset 'SECRET_W[1]'")
    expect(io.exitCode).not.toBe(0)
    expect(sess.arrays.SECRET_W).toEqual(['a', 'b'])
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

async function makeHiddenVarsWs(): Promise<Workspace> {
  const ws = await makeWs()
  const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
  sess.env.SLACK_TOKEN = 'xoxb-real'
  sess.env.PUBLIC = 'ok'
  sess.hiddenVars = { names: ['SLACK_TOKEN'] }
  return ws
}

describe('hidden vars across the shell tier', () => {
  it('assign-default writes the raw env under hidden vars', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('echo "${NEWVAR:=seeded}" && echo "$NEWVAR"', {
      sessionId: 'agent',
    })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('seeded\nseeded\n')
    expect(ws.getSession('agent').env.NEWVAR).toBe('seeded')
  })

  it('assign-default of a hidden var is refused', async () => {
    // ${SLACK_TOKEN:=fake} observes the hidden name as unset, so
    // without a gate the write-back would overwrite the real value
    // the host's wiring still reads; the door refuses like any denied
    // assignment.
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('echo "${SLACK_TOKEN:=fake}"', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('arithmetic assignment of a hidden var is refused', async () => {
    // $((X=5)) and ((X=5)) write the raw env on purpose, but a hidden
    // name is not theirs to clobber; both spellings refuse.
    const ws = await makeHiddenVarsWs()
    const expansion = await ws.execute('echo "$((SLACK_TOKEN=5))"', { sessionId: 'agent' })
    expect(expansion.exitCode).not.toBe(0)
    const command = await ws.execute('((SLACK_TOKEN=7))', { sessionId: 'agent' })
    expect(command.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('printf -v of a hidden var is refused', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('printf -v SLACK_TOKEN fake', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('expansion reads a hidden var as unset', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('echo "[$SLACK_TOKEN][$PUBLIC]"', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('[][ok]\n')
  })

  it('env and set listings omit hidden vars', async () => {
    const ws = await makeHiddenVarsWs()
    for (const line of ['env', 'set', 'export -p']) {
      const io = await ws.execute(line, { sessionId: 'agent' })
      expect(stdoutStr(io)).not.toContain('SLACK_TOKEN')
    }
  })

  it('exporting a hidden var is refused and preserves it', async () => {
    // A landed write would clobber the real value the host's wiring
    // still reads; a swallowed one would gaslight the agent.
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('export SLACK_TOKEN=fake', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('unset of a hidden var is quiet and preserves it', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('unset SLACK_TOKEN', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('a hidden HOME reads as unset everywhere', async () => {
    // HOME has its own resolution channel (homeDir feeds $HOME, tilde
    // expansion and bare `cd`), so hiding it must land there too, not
    // only on the generic env lookup.
    const ws = await makeHiddenVarsWs()
    const sess = ws.getSession('agent')
    sess.env.HOME = '/a/homedir'
    sess.hiddenVars = { names: ['SLACK_TOKEN', 'HOME'] }
    const home = await ws.execute('echo "[$HOME]"', { sessionId: 'agent' })
    expect(stdoutStr(home)).toBe('[]\n')
    const tilde = await ws.execute('echo ~', { sessionId: 'agent' })
    expect(stdoutStr(tilde)).toBe('~\n')
    const cd = await ws.execute('cd', { sessionId: 'agent' })
    expect(cd.exitCode).toBe(1)
  })

  it('expansion reads a hidden array as unset', async () => {
    // The embedder can seed session.arrays before narrowing, so a
    // hidden name can hold an array; every expansion spelling must
    // read it the way the scalar case does: as unset.
    const ws = await makeHiddenArrayWs()
    const io = await ws.execute(
      'echo "[$SLACK_TOKEN][${SLACK_TOKEN[0]}][${SLACK_TOKEN[@]}][${#SLACK_TOKEN[@]}]"',
      { sessionId: 'agent' },
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('[][][][0]\n')
    const splat = await ws.execute(
      'for el in "${SLACK_TOKEN[@]}"; do echo "el=$el"; done; echo end',
      { sessionId: 'agent' },
    )
    expect(splat.exitCode).toBe(0)
    expect(stdoutStr(splat)).toBe('end\n')
  })

  it('a prefix assignment of a hidden var is refused', async () => {
    // SLACK_TOKEN=fake cmd writes the raw env before dispatch, and a
    // function-call prefix deliberately never restores, so without a
    // gate a narrowed session permanently clobbers the host value.
    const ws = await makeHiddenVarsWs()
    await ws.execute('f() { echo ran; }', { sessionId: 'agent' })
    const fn = await ws.execute('SLACK_TOKEN=fake f', { sessionId: 'agent' })
    expect(fn.exitCode).not.toBe(0)
    const cmd = await ws.execute('SLACK_TOKEN=fake echo hi', { sessionId: 'agent' })
    expect(cmd.exitCode).not.toBe(0)
    const bare = await ws.execute('SLACK_TOKEN=fake OTHER=x', { sessionId: 'agent' })
    expect(bare.exitCode).not.toBe(0)
    const sess = ws.getSession('agent')
    expect(sess.env.SLACK_TOKEN).toBe('xoxb-real')
    expect('OTHER' in sess.env).toBe(false)
  })

  it('bare declare -a of a hidden var is refused', async () => {
    // `declare -a NAME` at top level migrates an existing scalar into
    // element 0 with raw writes, which would move the hidden value
    // into array storage; the door refuses instead.
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('declare -a SLACK_TOKEN', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    const sess = ws.getSession('agent')
    expect(sess.env.SLACK_TOKEN).toBe('xoxb-real')
    expect('SLACK_TOKEN' in sess.arrays).toBe(false)
  })

  it('unset of a hidden array is a quiet noop', async () => {
    // `unset name` and `unset name[i]` on a hidden array answer as
    // they would for an unset name: exit 0, nothing said, nothing
    // written, in either spelling.
    const ws = await makeHiddenArrayWs()
    const element = await ws.execute('unset "SLACK_TOKEN[1]"', { sessionId: 'agent' })
    expect(element.exitCode).toBe(0)
    const whole = await ws.execute('unset SLACK_TOKEN', { sessionId: 'agent' })
    expect(whole.exitCode).toBe(0)
    expect(ws.getSession('agent').arrays.SLACK_TOKEN).toEqual(['xoxb-real', 'xoxb-two'])
  })

  it('bare export of a hidden var is refused', async () => {
    // `export NAME` on a name that reads as unset writes an empty
    // entry, so on a hidden name it refuses like the valued form;
    // deciding from raw membership would quietly re-mark the hidden
    // name instead.
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('export SLACK_TOKEN', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('subscript arithmetic resolves against the visible env', async () => {
    // An assignment subscript evaluates as arithmetic, so a hidden
    // numeric read there would steer a visible array's write index
    // and leak by placement; hidden reads as unset, which is 0.
    const ws = await makeWs()
    const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    sess.env.SECRET_IDX = '1'
    sess.hiddenVars = { names: ['SECRET_IDX'] }
    await ws.execute('b=(x y)', { sessionId: 'agent' })
    const io = await ws.execute('b[SECRET_IDX]=z', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(ws.getSession('agent').arrays.b).toEqual(['z', 'y'])
  })
})

async function makeHiddenArrayWs(): Promise<Workspace> {
  const ws = await makeWs()
  const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
  sess.arrays.SLACK_TOKEN = ['xoxb-real', 'xoxb-two']
  sess.env.PUBLIC = 'ok'
  sess.hiddenVars = { names: ['SLACK_TOKEN'] }
  return ws
}

async function makeHiddenPathsWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const a = new RAMResource()
  a.store.files.set('/x.txt', ENC.encode('public\n'))
  a.store.files.set('/secrets/token.txt', ENC.encode('s3cr3t\n'))
  a.store.files.set('/note.key', ENC.encode('kkk\n'))
  a.store.dirs.add('/secrets')
  const ws = new Workspace({ '/a': a }, { mode: MountMode.WRITE, shellParser: parser })
  open.push(ws)
  const sess = ws.createSession('agent')
  sess.hiddenPaths = { paths: ['/a/secrets'], patterns: ['*.key'] }
  return ws
}

describe('hidden paths across the tiers', () => {
  it('the shell reads a hidden path as missing', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('cat /a/secrets/token.txt', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('s3cr3t')
    expect(stderrStr(io)).toContain('No such file')
  })

  it('a pattern-hidden file reads as missing', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('cat /a/note.key', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('kkk')
  })

  it('ls drops hidden names', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('ls /a', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('x.txt')
    expect(out).not.toContain('secrets')
    expect(out).not.toContain('note.key')
  })

  it('find predicates evaluate on the visible tree', async () => {
    // RAM ships a native find op, which classifies on the raw tree: a
    // visible directory whose only child is hidden would read as
    // nonempty there, so -empty would omit it and reveal that an
    // unseen child exists. Under hidden paths the generic must walk
    // through the guarded readdir instead.
    const parser = await getTestParser()
    const a = new RAMResource()
    a.store.files.set('/x.txt', ENC.encode('public\n'))
    a.store.files.set('/vault/only.key', ENC.encode('kkk\n'))
    a.store.dirs.add('/vault')
    const ws = new Workspace({ '/a': a }, { mode: MountMode.WRITE, shellParser: parser })
    open.push(ws)
    const sess = ws.createSession('agent')
    sess.hiddenPaths = { patterns: ['*.key'] }
    const io = await ws.execute('find /a -empty', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('/a/vault')
    expect(out).not.toContain('only.key')
  })

  it('ls of a hidden dir is no such file', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('ls /a/secrets', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('token')
  })

  it('find never reports hidden rows', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('find /a', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('/a/x.txt')
    expect(out).not.toContain('secrets')
    expect(out).not.toContain('.key')
  })

  it('du never counts hidden leaves', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('du -a /a', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('x.txt')
    expect(out).not.toContain('secrets')
    expect(out).not.toContain('.key')
  })

  it('a glob never matches a hidden name', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('cat /a/*.key', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('kkk')
  })

  it('a redirect into hidden space fails and writes nothing', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('echo hi > /a/secrets/new.txt', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    const a = ws.namespace.mountFor('/a/x.txt')
    const resource = a.resource as RAMResource
    expect(resource.store.files.has('/secrets/new.txt')).toBe(false)
  })

  it('the unscoped session sees everything', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('ls /a')
    const out = stdoutStr(io)
    expect(out).toContain('secrets')
    expect(out).toContain('note.key')
  })

  it('the fs facade agrees with the shell', async () => {
    const ws = await makeHiddenPathsWs()
    const sess = ws.getSession('agent')
    await runWithSession(sess, async () => {
      await expect(ws.fs.readFile('/a/secrets/token.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      const names = await ws.fs.readdir('/a')
      expect(names.some((n) => n.includes('secrets'))).toBe(false)
    })
  })
})

describe('session profiles', () => {
  it('a profile applies every narrowing field end to end', async () => {
    const parser = await getTestParser()
    const a = new RAMResource()
    a.store.files.set('/x.txt', ENC.encode('public\n'))
    a.store.files.set('/secrets/token.txt', ENC.encode('s3cr3t\n'))
    a.store.dirs.add('/secrets')
    const ws = new Workspace({ '/a': a }, { mode: MountMode.WRITE, shellParser: parser })
    open.push(ws)
    const analyst = {
      mounts: { '/a': 'write' },
      hiddenPaths: { paths: ['/a/secrets'] },
      hiddenVars: { names: ['SLACK_TOKEN'] },
      env: { ROLE: 'analyst' },
    }
    const s1 = ws.createSession('agent1', { profile: analyst })
    const s2 = ws.createSession('agent2', { profile: analyst })
    expect(s1.mountModes?.get('/a')).toBe(MountMode.WRITE)
    expect(s1.hiddenPaths).toBe(analyst.hiddenPaths)
    expect(s2.hiddenPaths).toBe(analyst.hiddenPaths)
    expect(s1.env.ROLE).toBe('analyst')
    const listing = await ws.execute('ls /a', { sessionId: 'agent1' })
    expect(stdoutStr(listing)).not.toContain('secrets')
    const role = await ws.execute('echo "$ROLE"', { sessionId: 'agent1' })
    expect(stdoutStr(role)).toBe('analyst\n')
  })
})
