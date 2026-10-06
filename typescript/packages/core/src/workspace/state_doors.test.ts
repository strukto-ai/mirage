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

import { seedVar } from '../workspace/session/state.ts'
import { VarAttr } from '../shell/variable.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { RegisteredCommand } from '../commands/config.ts'
import { CommandSpec, Operand } from '../commands/spec/types.ts'
import { runWithSession } from '../context/session_context.ts'
import { IOResult } from '../io/types.ts'
import { OpsRegistry, type RegisteredOp } from '../ops/registry.ts'
import type {
  Action,
  Decision,
  CommandContext,
  OpsContext,
  Policy,
  SessionContext,
} from '../policy/index.ts'
import { Outcome, Scope, type AskHandler } from '../policy/index.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { ops } from '../test-utils.ts'
import { Runtime } from '../runtime/base.ts'
import { LINE_EXECUTOR, type LineExecutor } from '../runtime/mixin.ts'
import type { RunResult } from '../runtime/types.ts'
import { MountMode, PathSpec, VFSName } from '../types.ts'
import { cliSpecFor } from '../commands/cli/specs.ts'
import { parseSessionProfile, type SessionProfile } from '../policy/profile.ts'
import { getTestParser, stderrStr, stdoutStr, voicedStderr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

const ENC = new TextEncoder()

/** Refuse one op name outright, whatever path asked. */
class DenyOp implements Policy {
  private readonly op: string
  constructor(op: string) {
    this.op = op
  }
  preOps(ctx: OpsContext): Action | null {
    if (ctx.op === this.op) return { kind: 'deny', reason: `${this.op} refused by policy` }
    return null
  }
}

// Ops resolve by VFS name in the workspace registry, so an
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
  const a = new RAMVFS()
  a.store.files.set('/x.txt', ENC.encode('public\n'))
  const b = new RAMVFS()
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
    const io = await ws.shell('ln -s x.txt /a/lk')
    expect(io.exitCode).not.toBe(0)
    expect(voicedStderr(io)).toContain('Permission denied')
    expect(ws.namespace.isLink('/a/lk')).toBe(false)
  })

  it('ln leaves an op record', async () => {
    // The op ledger must not say a workspace with ln traffic did
    // nothing: the door records the namespace write like any other op.
    const ws = await makeWs()
    const io = await ws.shell('ln -s x.txt /a/lk')
    expect(io.exitCode).toBe(0)
    expect(ws.records.some((r) => r.op === 'symlink' && r.path === '/a/lk')).toBe(true)
  })

  it('scoped shell ln onto hidden turf is refused', async () => {
    const ws = await makeWs()
    ws.createSession('agent', { profile: { paths: { hide: ['/b'] } } })
    const io = await ws.shell('ln -s /a/x.txt /b/lk', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.namespace.isLink('/b/lk')).toBe(false)
  })

  it('scoped shell ln does not follow a hidden link into its directory', async () => {
    // A hidden link to a visible directory is not a directory the session
    // can link into: the door checks the typed path before it follows,
    // and ln's own directory probe has to agree, or the link lands in
    // the directory the hidden link points at.
    const ws = await makeWs()
    for (const line of ['mkdir -p /a/d', 'ln -s /a/d /a/hl']) {
      expect((await ws.shell(line)).exitCode).toBe(0)
    }
    ws.createSession('agent', { profile: { paths: { hide: ['/a/hl'] } } })
    const io = await ws.shell('ln -s /a/x.txt /a/hl', { sessionId: 'agent' })
    expect(io.exitCode).toBe(1)
    expect(voicedStderr(io)).toBe("ln: failed to create symbolic link '/a/hl': Permission denied\n")
    expect(ws.namespace.isLink('/a/d/x.txt')).toBe(false)
  })

  it('scoped shell hard ln of a hidden link has nothing to copy', async () => {
    // A hard link of a link copies the link, and -L copies its target's
    // bytes; a hidden link has neither to give.
    const ws = await makeWs()
    expect((await ws.shell('ln -s /a/x.txt /a/hl')).exitCode).toBe(0)
    ws.createSession('agent', { profile: { paths: { hide: ['/a/hl'] } } })
    for (const line of ['ln /a/hl /a/copy', 'ln -L /a/hl /a/copy2']) {
      const io = await ws.shell(line, { sessionId: 'agent' })
      expect(io.exitCode).toBe(1)
      expect(voicedStderr(io)).toBe("ln: failed to access '/a/hl': No such file or directory\n")
    }
    expect(ws.namespace.isLink('/a/copy')).toBe(false)
  })

  it('scoped shell ln onto a hidden mount root does not say it exists', async () => {
    const ws = await makeWs()
    ws.createSession('agent', { profile: { paths: { hide: ['/b'] } } })
    const io = await ws.shell('ln -sT /a/x.txt /b', { sessionId: 'agent' })
    expect(io.exitCode).toBe(1)
    expect(voicedStderr(io)).toBe("ln: failed to create symbolic link '/b': Permission denied\n")
  })

  it('symlink and readlink answer on the op facade', async () => {
    // readlink is the read twin: guests and CLIs ask through the same
    // door instead of a bespoke channel.
    const ws = await makeWs()
    await ws.vfs.symlink('/a/lk', 'x.txt')
    expect(await ws.vfs.readlink('/a/lk')).toBe('x.txt')
    expect(ws.namespace.readlink('/a/lk')).toBe('x.txt')
  })

  it('readlink on a non-link reports EINVAL', async () => {
    const ws = await makeWs()
    await expect(ws.vfs.readlink('/a/x.txt')).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('scoped shell readlink on hidden turf is refused', async () => {
    // The read twin of the scoped-ln hole: a session that cannot see /b
    // must not learn /b/lk's target through the readlink builtin, which
    // used to read the node table directly instead of dispatching.
    const ws = await makeWs()
    ws.createSession('agent', { profile: { paths: { hide: ['/b'] } } })
    const made = await ws.shell('ln -s /b/y.txt /b/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.shell('readlink /b/lk', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('y.txt')
  })

  it('scoped shell readlink -m on hidden turf is refused', async () => {
    // -m/-f canonicalize without any existence probe, so without the
    // gate they printed the resolved target of a hidden link.
    const ws = await makeWs()
    ws.createSession('agent', { profile: { paths: { hide: ['/b'] } } })
    const made = await ws.shell('ln -s /b/y.txt /b/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.shell('readlink -m /b/lk', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('y.txt')
  })

  it('shell readlink fires the op gates', async () => {
    const ws = await makeWs([new DenyOp('readlink')])
    const made = await ws.shell('ln -s x.txt /a/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.shell('readlink /a/lk')
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('x.txt')
  })

  it("facade symlink respects the session's view", async () => {
    const ws = await makeWs()
    const sess = ws.createSession('agent', { profile: { paths: { hide: ['/b'] } } })
    await runWithSession(sess, async () => {
      await ws.vfs.symlink('/a/lk', 'x.txt')
      // The hidden mount does not exist for the session, so a create
      // under it answers ENOENT as every read does; only a create at a
      // hidden name inside a visible directory is EACCES.
      await expect(ws.vfs.symlink('/b/lk', 'y.txt')).rejects.toMatchObject({ code: 'ENOENT' })
    })
    expect(ws.namespace.isLink('/a/lk')).toBe(true)
    expect(ws.namespace.isLink('/b/lk')).toBe(false)
  })

  it('chown -h on a link fires the op gates', async () => {
    // chown -h writes the link's own attrs; that overlay write used to
    // bypass the door entirely, so no policy could bound it.
    const ws = await makeWs([new DenyOp('setattr')])
    const made = await ws.shell('ln -s x.txt /a/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.shell('chown -h alice /a/lk')
    expect(io.exitCode).not.toBe(0)
    expect(voicedStderr(io)).toContain('refused by policy')
    expect(ws.namespace.metaFor('/a/lk')?.uid).toBeUndefined()
  })

  it('overlay setattr fires the op gates', async () => {
    // A backend with no native setattr op stores attrs in the namespace
    // overlay; that write must clear the same gates as a native one.
    const parser = await getTestParser()
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', ENC.encode('body\n'))
    const ws = new Workspace(
      { '/o': vfs },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        ops: new NoSetattrRegistry(),
        policies: [new DenyOp('setattr')],
      },
    )
    open.push(ws)
    const io = await ws.shell('chmod 600 /o/f.txt')
    expect(io.exitCode).not.toBe(0)
    expect(voicedStderr(io)).toContain('refused by policy')
    expect(ws.namespace.metaFor('/o/f.txt')?.mode).toBeUndefined()
  })

  it('overlay setattr still lands without policies', async () => {
    const parser = await getTestParser()
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', ENC.encode('body\n'))
    const ws = new Workspace(
      { '/o': vfs },
      { mode: MountMode.WRITE, shellParser: parser, ops: new NoSetattrRegistry() },
    )
    open.push(ws)
    const io = await ws.shell('chmod 600 /o/f.txt')
    expect(io.exitCode).toBe(0)
    expect(ws.namespace.metaFor('/o/f.txt')?.mode).toBe(0o600)
  })
})

/** Veto env writes to SECRET_* names through the session view. */
class DenySecretEnv implements Policy {
  preSession(ctx: SessionContext): Action | null {
    if (ctx.plane === 'env' && ctx.key.startsWith('SECRET')) {
      return { kind: 'deny', reason: 'SECRET_* refused by policy' }
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
    const denied = await ws.shell('export SECRET_X=1')
    expect(denied.exitCode).not.toBe(0)
    expect(voicedStderr(denied)).toContain('refused by policy')
    expect('SECRET_X' in ws.env).toBe(false)
    const allowed = await ws.shell('export PUBLIC_X=1')
    expect(allowed.exitCode).toBe(0)
    expect(ws.env.PUBLIC_X).toBe('1')
  })

  it('a prefix assignment clears the gate', async () => {
    // `SECRET=leak cmd` is a session write like any other, and the form
    // puts it in the command's environment, so a deployment refusing
    // `SECRET_*` has to be asked. Only the hidden half was checked here,
    // and the seeding goes through the ungated door, so the secret
    // reached the command and printed.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.shell('SECRET_K=leak printenv SECRET_K')
    expect(denied.exitCode).not.toBe(0)
    expect(voicedStderr(denied)).toContain('refused by policy')
    expect(stdoutStr(denied)).toBe('')
    // A name no rule covers still reaches the command.
    const allowed = await ws.shell('OPEN_K=fine printenv OPEN_K')
    expect(stdoutStr(allowed)).toBe('fine\n')
  })

  it('declare -x on an existing name clears the gate', async () => {
    // `declare -x NAME` on a name that already exists writes no value,
    // so the handler reaches the gate on no other path and the export
    // mark is the only session write there is. Stamping it directly let
    // an agent export a host-seeded credential the deployment refused.
    const ws = await makeWs([new DenySecretEnv()])
    const sess = ws.getSession(ws.defaultSessionId)
    seedVar(sess, 'SECRET_TOKEN', 'hunter2')
    const io = await ws.shell('declare -x SECRET_TOKEN')
    expect(io.exitCode).not.toBe(0)
    expect(voicedStderr(io)).toContain('refused by policy')
    expect(sess.vars.SECRET_TOKEN?.attrs.has(VarAttr.Export)).toBe(false)
    expect(sess.vars.SECRET_TOKEN?.value).toBe('hunter2')
  })

  it('stamps what stored despite a bad sibling', async () => {
    // GNU keeps the valid operands and reports the invalid one, so
    // `declare -x GOOD=1 1BAD=x` exits 1 and still answers
    // `declare -x GOOD="1"`. Gating the stamp on the aggregate status
    // left GOOD unexported. Pinned on bash 5.2.37.
    const ws = await makeWs([])
    const bad = await ws.shell('declare -x QGOOD=1 1BAD=x')
    expect(bad.exitCode).toBe(1)
    expect(voicedStderr(bad)).toContain('not a valid identifier')
    const shown = await ws.shell('declare -p QGOOD')
    expect(stdoutStr(shown)).toBe('declare -x QGOOD="1"\n')
  })

  it('command env is a snapshot, not the live dict', async () => {
    // A command's env is the process view: a child cannot write the
    // parent's environment, so a mutation must not land in the session.
    const ws = await makeWs()
    const rc = new RegisteredCommand({
      name: 'envpoke',
      spec: CMD_SPEC,
      vfs: VFSName.RAM,
      fn: (_accessor, _paths, _texts, opts) => {
        expect(opts.env).toBeDefined()
        if (opts.env !== undefined) opts.env.INJECTED = '1'
        return [new Uint8Array(), new IOResult()]
      },
    })
    ws.registry.mountForPrefix('/a').register(rc)
    const io = await ws.shell('envpoke /a/x.txt')
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
      vfs: VFSName.RAM,
      fn: (_accessor, _paths, _texts, opts) => {
        const value = opts.sessionView?.get('MARKER') ?? 'none'
        return [ENC.encode(value), new IOResult()]
      },
    })
    ws.registry.mountForPrefix('/a').register(rc)
    await ws.shell('export MARKER=yes')
    const io = await ws.shell('envread /a/x.txt')
    expect(stdoutStr(io).trim()).toBe('yes')
  })
})

describe('the remaining session writers clear the same gate', () => {
  it('bare export of a new name fires the gate', async () => {
    // `export NAME` writes no value, but marking a name is still a
    // session write, so it clears the same gate an assignment does.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.shell('export SECRET_BARE')
    expect(denied.exitCode).not.toBe(0)
    expect(voicedStderr(denied)).toContain('refused by policy')
    expect('SECRET_BARE' in ws.env).toBe(false)
    const allowed = await ws.shell('export PUBLIC_BARE')
    expect(allowed.exitCode).toBe(0)
    // Marked but unset, which is bash's third state: `export -p` lists
    // it bare while the environment does not carry it at all.
    expect(ws.env.PUBLIC_BARE).toBeUndefined()
    const listed = stdoutStr(await ws.shell('export -p'))
    expect(listed).toContain('declare -x PUBLIC_BARE\n')
    expect(listed).not.toContain('SECRET_BARE')
  })

  it('local fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.shell('f() { local SECRET_L=1; }; f')
    expect(io.exitCode).not.toBe(0)
    expect(voicedStderr(io)).toContain('refused by policy')
    expect('SECRET_L' in ws.env).toBe(false)
  })

  it('every declaring spelling fires the gate', async () => {
    // `readonly NAME` marked through `setAttr` and walked straight past
    // it: a deployment refusing SECRET_* still saw the line exit 0,
    // create the record, and freeze the name against every later write
    // the deployment's own wiring would make.
    const ws = await makeWs([new DenySecretEnv()])
    const session = ws.getSession(ws.defaultSessionId)
    for (const line of [
      'SECRET_A=1',
      'export SECRET_B',
      'readonly SECRET_C',
      'readonly SECRET_D=1',
      'declare SECRET_E',
    ]) {
      const io = await ws.shell(line)
      expect(io.exitCode, line).not.toBe(0)
      expect(voicedStderr(io), line).toContain('refused by policy')
    }
    for (const name of ['SECRET_A', 'SECRET_B', 'SECRET_C', 'SECRET_D', 'SECRET_E']) {
      expect(name in session.vars, name).toBe(false)
    }
  })

  it('a plain assignment fires the gate', async () => {
    // The assignment path used to write session.env directly, so a
    // policy that vetoed `export SECRET_X=1` still admitted
    // `SECRET_X=1`. Denial mirrors the readonly case: a fatal
    // variable-assignment error that abandons the rest of the line.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.shell('SECRET_P=1; echo after')
    expect(denied.exitCode).not.toBe(0)
    expect(voicedStderr(denied)).toContain('refused by policy')
    expect('SECRET_P' in ws.env).toBe(false)
    const allowed = await ws.shell('PUBLIC_P=1')
    expect(allowed.exitCode).toBe(0)
    expect(ws.env.PUBLIC_P).toBe('1')
  })

  it('an append assignment fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.shell('SECRET_A+=x')
    expect(io.exitCode).not.toBe(0)
    expect('SECRET_A' in ws.env).toBe(false)
  })

  it('an array assignment fires the gate', async () => {
    // A denied name must not be writable by switching to array syntax:
    // SECRET=(a b) lands on the same session plane as SECRET=x.
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.shell('SECRET_V=(a b); echo after')
    expect(io.exitCode).not.toBe(0)
    expect(voicedStderr(io)).toContain('refused by policy')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_V' in sess.arrays).toBe(false)
  })

  it('an array append assignment fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.shell('SECRET_VA+=(a)')
    expect(io.exitCode).not.toBe(0)
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_VA' in sess.arrays).toBe(false)
  })

  it('a subscript assignment fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.shell('SECRET_S[0]=x')
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
    seedVar(sess, 'SECRET_E', ['a'])
    const io = await ws.shell('SECRET_E+=x')
    expect(io.exitCode).not.toBe(0)
    expect(sess.arrays.SECRET_E).toEqual(['a'])
  })

  it('a declaration array assignment fires the gate', async () => {
    // export/declare with an array literal store through the staged
    // path, not handleExport, so the gate has to fire there too.
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.shell('export SECRET_D=(a)')
    expect(io.exitCode).not.toBe(0)
    expect(voicedStderr(io)).toContain('refused by policy')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_D' in sess.arrays).toBe(false)
  })

  it('a readonly name refuses a declaration array store', async () => {
    // The staged-array store is the builtin's own; the shell's readonly
    // rule is pre-checked there, before the door is asked.
    const ws = await makeWs()
    await ws.shell('readonly LOCKED')
    const io = await ws.shell('export LOCKED=(a)')
    expect(io.exitCode).not.toBe(0)
    expect(voicedStderr(io)).toContain('readonly variable')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('LOCKED' in sess.arrays).toBe(false)
  })

  it('a readonly declaration array abandons the line', async () => {
    // GNU treats `export LOCKED=(a)` on a readonly name as a variable
    // assignment error, not a builtin failure: the rest of the line is
    // dead (status 1) and the next line runs. Pinned on bash 5.2
    // (debian:stable-slim); the scalar spelling below continues.
    const ws = await makeWs()
    await ws.shell('readonly LOCKED')
    const denied = await ws.shell('export LOCKED=(a); echo unreached')
    expect(denied.exitCode).toBe(1)
    expect(stdoutStr(denied)).toBe('')
    expect(voicedStderr(denied)).toBe('bash: LOCKED: readonly variable\n')
    const after = await ws.shell('echo after')
    expect(after.exitCode).toBe(0)
  })

  it('a readonly declare array is fatal at top level', async () => {
    const ws = await makeWs()
    await ws.shell('readonly LOCKED')
    const denied = await ws.shell('declare LOCKED=(a); echo unreached')
    expect(denied.exitCode).toBe(1)
    expect(stdoutStr(denied)).toBe('')
  })

  it('a readonly scalar export refusal continues the line', async () => {
    // The asymmetry is GNU's: `export LOCKED=v` fails with 1 in the
    // builtin's voice and the same line keeps going.
    const ws = await makeWs()
    await ws.shell('readonly LOCKED')
    const io = await ws.shell('export LOCKED=v; echo rc=$?')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('rc=1\n')
  })

  it('a readonly local array refusal stays in the function', async () => {
    // `local LOCKED=(a)` on a readonly global refuses without killing
    // the function body (GNU prints the refusal and runs `echo in-f`).
    const ws = await makeWs()
    await ws.shell('readonly LOCKED')
    const io = await ws.shell('f() { local LOCKED=(a); echo in-f; }; f')
    expect(stdoutStr(io)).toContain('in-f')
    expect(voicedStderr(io)).toContain('readonly variable')
  })

  it('export of an array literal prints nothing', async () => {
    // `export ARR=(x y)` used to fall through to the bare-export print
    // branch because the handler never learned arrays were on the line.
    const ws = await makeWs()
    const io = await ws.shell('export ARR=(x y)')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect(sess.arrays.ARR).toEqual(['x', 'y'])
  })

  it('a readonly loop variable refuses before the body', async () => {
    // bash refuses a readonly loop variable and never runs the body;
    // the loop writes go through the view now, same as any assignment.
    const ws = await makeWs()
    await ws.shell('readonly LV')
    const denied = await ws.shell('for LV in a b; do echo ran; done')
    expect(denied.exitCode).not.toBe(0)
    expect(stdoutStr(denied)).not.toContain('ran')
  })

  it('a subscripted unset of a scalar fires the gate', async () => {
    // `unset 'SECRET[0]'` on a scalar is the whole unset in element
    // clothing; the element branch used to skip the view entirely.
    const ws = await makeWs([new DenySecretEnv()])
    seedVar(ws.getSession(ws.defaultSessionId), 'SECRET_U', 'v')
    const io = await ws.shell("unset 'SECRET_U[0]'")
    expect(io.exitCode).not.toBe(0)
    expect(voicedStderr(io)).toContain('refused by policy')
    expect(ws.env.SECRET_U).toBe('v')
  })

  it('a subscripted unset of an array element fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    seedVar(sess, 'SECRET_W', ['a', 'b'])
    const io = await ws.shell("unset 'SECRET_W[1]'")
    expect(io.exitCode).not.toBe(0)
    expect(sess.arrays.SECRET_W).toEqual(['a', 'b'])
  })

  it('the for-loop variable fires the gate', async () => {
    // The loop variable is a session write per iteration; a denied
    // write aborts the loop before its body runs.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.shell('for SECRET_I in a b; do echo ran; done')
    expect(denied.exitCode).not.toBe(0)
    expect(stdoutStr(denied)).not.toContain('ran')
    expect('SECRET_I' in ws.env).toBe(false)
    const allowed = await ws.shell('for PUB_I in a b; do echo ok; done')
    expect(allowed.exitCode).toBe(0)
    expect(stdoutStr(allowed).match(/ok/g)?.length).toBe(2)
  })
})

/** Seal one file's reads and one subtree's writes wherever preOps fires. */
class SealedPaths implements Policy {
  preOps(ctx: OpsContext): Action | null {
    if (!ctx.write && ctx.path.virtual === '/a/secret.txt') {
      return { kind: 'deny', reason: 'secret is sealed' }
    }
    // The subtree spelling covers the root too: a native tree op
    // (rm_r) admits as one op on the root, per the preOps docstring.
    if (ctx.write && (ctx.path.virtual === '/a/prod' || ctx.path.virtual.startsWith('/a/prod/'))) {
      return { kind: 'deny', reason: 'prod is read-only' }
    }
    return null
  }
}

/** Record every op preOps is asked about; allow them all. */
class OpRecorder implements Policy {
  readonly asked: [string, string, boolean][] = []
  preOps(ctx: OpsContext): Action | null {
    this.asked.push([ctx.op, ctx.path.virtual, ctx.write])
    return null
  }
}

/** Record each op with the identity fields a scoped policy keys on. */
class IdentityRecorder implements Policy {
  readonly asked: [string, string, string, string][] = []
  preOps(ctx: OpsContext): Action | null {
    this.asked.push([ctx.op, ctx.path.virtual, ctx.prefix, ctx.sessionId ?? ''])
    return null
  }
}

async function makeSealedWs(policies: Policy[]): Promise<Workspace> {
  // Seeded through the door (not the raw store) so the index knows the
  // implicit /a/prod directory, then the policies join, mirroring the
  // python twin's setup order.
  const parser = await getTestParser()
  const vfs = new RAMVFS()
  vfs.store.files.set('/secret.txt', ENC.encode('sealed\n'))
  vfs.store.files.set('/ok.txt', ENC.encode('has sealed word\n'))
  const ws = new Workspace({ '/a': vfs }, { mode: MountMode.WRITE, shellParser: parser })
  open.push(ws)
  await ws.shell('mkdir -p /a/prod')
  await ws.vfs.write('/a/prod/keep.txt', ENC.encode('keep\n'))
  for (const p of policies) ws.policies.add(p)
  return ws
}

describe('op hooks bind at the op doors and the command tier', () => {
  it('preOps refuses the doors and handler I/O alike', async () => {
    // The documented boundary (Policy.preOps): coded op hooks fire at
    // the op doors AND for the backend I/O inside a mount command's
    // handler (withPolicyGuard). Both tiers are pinned so a move of
    // the boundary is loud.
    const ws = await makeSealedWs([new SealedPaths()])

    // The doors hold: the op facade, and a dispatcher-routed redirect
    // write.
    await expect(ws.vfs.read('/a/secret.txt')).rejects.toMatchObject({
      refusal: { reason: 'secret is sealed' },
    })
    const redirect = await ws.shell('echo hi > /a/prod/new.txt')
    expect(redirect.exitCode).not.toBe(0)

    // The command tier consults the same hooks: the read refuses in
    // the command's own voice and the deletion never lands.
    const leak = await ws.shell('cat /a/secret.txt')
    expect(leak.exitCode).not.toBe(0)
    expect(stdoutStr(leak)).toBe('')
    expect(voicedStderr(leak)).toContain('cat: /a/secret.txt: Permission denied')
    const removed = await ws.shell('rm /a/prod/keep.txt')
    expect(removed.exitCode).not.toBe(0)
    const kept = await ws.shell('cat /a/prod/keep.txt')
    expect(kept.exitCode).toBe(0)
    expect(stdoutStr(kept)).toBe('keep\n')
  })

  it('preOps holds walks and lazy readers', async () => {
    // A walk is held per entry (GNU's unreadable-file shape: the other
    // entries still serve, stderr names the refused one), and a reader
    // the output pipeline drains after dispatch (head binds a lazy
    // stream) still answers through the wrap-time capture.
    const ws = await makeSealedWs([new SealedPaths()])
    const walked = await ws.shell('grep -r sealed /a')
    expect(walked.exitCode).toBe(2)
    expect(stdoutStr(walked)).toContain('/a/ok.txt:has sealed word')
    expect(stdoutStr(walked)).not.toContain('sealed\n')
    expect(voicedStderr(walked)).toContain('grep: /a/secret.txt: Permission denied')

    const lazy = await ws.shell('head -c 3 /a/secret.txt')
    expect(lazy.exitCode).not.toBe(0)
    expect(voicedStderr(lazy)).toContain(
      "head: cannot open '/a/secret.txt' for reading: Permission denied",
    )
    const fine = await ws.shell('head -c 3 /a/ok.txt')
    expect(fine.exitCode).toBe(0)
    expect(stdoutStr(fine)).toBe('has')
  })

  it('denied entries still list and stat', async () => {
    // Presence facts stay unguarded on the command tier (mode-000
    // shape): a read-denied entry lists and stats, the read of it is
    // what fails.
    const ws = await makeSealedWs([new SealedPaths()])
    const listing = await ws.shell('ls -l /a')
    expect(listing.exitCode).toBe(0)
    expect(stdoutStr(listing)).toContain('secret.txt')
    const found = await ws.shell('find /a -type f')
    expect(found.exitCode).toBe(0)
    expect(stdoutStr(found)).toContain('/a/secret.txt')
  })

  it('shell rm -r admits through preOps', async () => {
    // The cascade asymmetry closed: an ops-door rmdir cascade always
    // admitted per deletion while a shell rm -r admitted nothing. The
    // shell tree removal now admits the op the backend performs, and
    // the subtree write-deny refuses it outright.
    const recorder = new OpRecorder()
    const ws = await makeSealedWs([recorder])
    const removed = await ws.shell('rm -r /a/prod')
    expect(removed.exitCode).toBe(0)
    expect(
      recorder.asked.some(([op, path, write]) => write && path === '/a/prod' && op === 'rm_r'),
    ).toBe(true)

    const sealed = await makeSealedWs([new SealedPaths()])
    const refused = await sealed.shell('rm -r /a/prod')
    expect(refused.exitCode).not.toBe(0)
    const survives = await sealed.shell('cat /a/prod/keep.txt')
    expect(survives.exitCode).toBe(0)
  })

  it('find -delete admits each deletion exactly once', async () => {
    // find's -delete admits the removal itself (in find's own refusal
    // voice) and suspends the delegated rm's slots, so a counting or
    // budget policy sees one deletion once, not twice.
    const recorder = new OpRecorder()
    const ws = await makeSealedWs([recorder])
    const removed = await ws.shell('find /a/prod -name keep.txt -delete')
    expect(removed.exitCode).toBe(0)
    const gone = await ws.shell('cat /a/prod/keep.txt')
    expect(gone.exitCode).not.toBe(0)
    const writes = recorder.asked.filter(([, path, write]) => path === '/a/prod/keep.txt' && write)
    expect(writes).toEqual([['unlink', '/a/prod/keep.txt', true]])
  })

  it('preOps sees the session and prefix on lazy drains', async () => {
    // OpsContext.prefix and .sessionId name the command's identity on
    // the command tier exactly as at the op doors, including for a
    // reader the pipeline drains after the gate scopes return (head
    // binds a lazy stream); both ride the wrap-time capture.
    const recorder = new IdentityRecorder()
    const ws = await makeSealedWs([recorder])
    expect((await ws.shell('cat /a/ok.txt')).exitCode).toBe(0)
    expect((await ws.shell('head -c 3 /a/ok.txt')).exitCode).toBe(0)
    const reads = recorder.asked.filter(([, path]) => path === '/a/ok.txt')
    expect(reads.length).toBeGreaterThan(0)
    for (const [, , prefix, sessionId] of reads) {
      expect(prefix).toBe('/a')
      expect(sessionId).toBe(ws.defaultSessionId)
    }
  })
})

async function makeHiddenVarsWs(): Promise<Workspace> {
  const ws = await makeWs()
  const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
  seedVar(sess, 'SLACK_TOKEN', 'xoxb-real')
  seedVar(sess, 'PUBLIC', 'ok')
  sess.visibility = { ...sess.visibility, vars: { names: ['SLACK_TOKEN'] } }
  return ws
}

describe('hidden vars across the shell tier', () => {
  it('assign-default writes the raw env under hidden vars', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.shell('echo "${NEWVAR:=seeded}" && echo "$NEWVAR"', {
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
    const io = await ws.shell('echo "${SLACK_TOKEN:=fake}"', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('arithmetic assignment of a hidden var is refused', async () => {
    // $((X=5)) and ((X=5)) write the raw env on purpose, but a hidden
    // name is not theirs to clobber; both spellings refuse.
    const ws = await makeHiddenVarsWs()
    const expansion = await ws.shell('echo "$((SLACK_TOKEN=5))"', { sessionId: 'agent' })
    expect(expansion.exitCode).not.toBe(0)
    const command = await ws.shell('((SLACK_TOKEN=7))', { sessionId: 'agent' })
    expect(command.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('printf -v of a hidden var is refused', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.shell('printf -v SLACK_TOKEN fake', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('expansion reads a hidden var as unset', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.shell('echo "[$SLACK_TOKEN][$PUBLIC]"', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('[][ok]\n')
  })

  it('env and set listings omit hidden vars', async () => {
    const ws = await makeHiddenVarsWs()
    for (const line of ['env', 'set', 'export -p']) {
      const io = await ws.shell(line, { sessionId: 'agent' })
      expect(stdoutStr(io)).not.toContain('SLACK_TOKEN')
    }
  })

  it('exporting a hidden var is refused and preserves it', async () => {
    // A landed write would clobber the real value the host's wiring
    // still reads; a swallowed one would gaslight the agent.
    const ws = await makeHiddenVarsWs()
    const io = await ws.shell('export SLACK_TOKEN=fake', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('unset of a hidden var is quiet and preserves it', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.shell('unset SLACK_TOKEN', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('a hidden HOME reads as unset everywhere', async () => {
    // HOME has its own resolution channel (homeDir feeds $HOME, tilde
    // expansion and bare `cd`), so hiding it must land there too, not
    // only on the generic env lookup.
    const ws = await makeHiddenVarsWs()
    const sess = ws.getSession('agent')
    seedVar(sess, 'HOME', '/a/homedir')
    sess.visibility = { ...sess.visibility, vars: { names: ['SLACK_TOKEN', 'HOME'] } }
    const home = await ws.shell('echo "[$HOME]"', { sessionId: 'agent' })
    expect(stdoutStr(home)).toBe('[]\n')
    const tilde = await ws.shell('echo ~', { sessionId: 'agent' })
    expect(stdoutStr(tilde)).toBe('~\n')
    const cd = await ws.shell('cd', { sessionId: 'agent' })
    expect(cd.exitCode).toBe(1)
  })

  it('expansion reads a hidden array as unset', async () => {
    // The embedder can seed session.arrays before narrowing, so a
    // hidden name can hold an array; every expansion spelling must
    // read it the way the scalar case does: as unset.
    const ws = await makeHiddenArrayWs()
    const io = await ws.shell(
      'echo "[$SLACK_TOKEN][${SLACK_TOKEN[0]}][${SLACK_TOKEN[@]}][${#SLACK_TOKEN[@]}]"',
      { sessionId: 'agent' },
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('[][][][0]\n')
    const splat = await ws.shell(
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
    await ws.shell('f() { echo ran; }', { sessionId: 'agent' })
    const fn = await ws.shell('SLACK_TOKEN=fake f', { sessionId: 'agent' })
    expect(fn.exitCode).not.toBe(0)
    const cmd = await ws.shell('SLACK_TOKEN=fake echo hi', { sessionId: 'agent' })
    expect(cmd.exitCode).not.toBe(0)
    const bare = await ws.shell('SLACK_TOKEN=fake OTHER=x', { sessionId: 'agent' })
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
    const io = await ws.shell('declare -a SLACK_TOKEN', { sessionId: 'agent' })
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
    const element = await ws.shell('unset "SLACK_TOKEN[1]"', { sessionId: 'agent' })
    expect(element.exitCode).toBe(0)
    const whole = await ws.shell('unset SLACK_TOKEN', { sessionId: 'agent' })
    expect(whole.exitCode).toBe(0)
    expect(ws.getSession('agent').arrays.SLACK_TOKEN).toEqual(['xoxb-real', 'xoxb-two'])
  })

  it('bare export of a hidden var is refused', async () => {
    // `export NAME` on a name that reads as unset writes an empty
    // entry, so on a hidden name it refuses like the valued form;
    // deciding from raw membership would quietly re-mark the hidden
    // name instead.
    const ws = await makeHiddenVarsWs()
    const io = await ws.shell('export SLACK_TOKEN', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('subscript arithmetic resolves against the visible env', async () => {
    // An assignment subscript evaluates as arithmetic, so a hidden
    // numeric read there would steer a visible array's write index
    // and leak by placement; hidden reads as unset, which is 0.
    const ws = await makeWs()
    const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    seedVar(sess, 'SECRET_IDX', '1')
    sess.visibility = { ...sess.visibility, vars: { names: ['SECRET_IDX'] } }
    await ws.shell('b=(x y)', { sessionId: 'agent' })
    const io = await ws.shell('b[SECRET_IDX]=z', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(ws.getSession('agent').arrays.b).toEqual(['z', 'y'])
  })
})

async function makeHiddenArrayWs(): Promise<Workspace> {
  const ws = await makeWs()
  const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
  seedVar(sess, 'SLACK_TOKEN', ['xoxb-real', 'xoxb-two'])
  seedVar(sess, 'PUBLIC', 'ok')
  sess.visibility = { ...sess.visibility, vars: { names: ['SLACK_TOKEN'] } }
  return ws
}

async function makeHiddenPathsWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const a = new RAMVFS()
  a.store.files.set('/x.txt', ENC.encode('public\n'))
  a.store.files.set('/secrets/token.txt', ENC.encode('s3cr3t\n'))
  a.store.files.set('/note.key', ENC.encode('kkk\n'))
  a.store.dirs.add('/secrets')
  const ws = new Workspace({ '/a': a }, { mode: MountMode.WRITE, shellParser: parser })
  open.push(ws)
  const sess = ws.createSession('agent')
  sess.visibility = { ...sess.visibility, paths: { paths: ['/a/secrets'], patterns: ['*.key'] } }
  return ws
}

describe('hidden paths across the tiers', () => {
  it('the shell reads a hidden path as missing', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.shell('cat /a/secrets/token.txt', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('s3cr3t')
    expect(voicedStderr(io)).toContain('No such file')
  })

  it('a pattern-hidden file reads as missing', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.shell('cat /a/note.key', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('kkk')
  })

  it('ls drops hidden names', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.shell('ls /a', { sessionId: 'agent' })
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
    const a = new RAMVFS()
    a.store.files.set('/x.txt', ENC.encode('public\n'))
    a.store.files.set('/vault/only.key', ENC.encode('kkk\n'))
    a.store.dirs.add('/vault')
    const ws = new Workspace({ '/a': a }, { mode: MountMode.WRITE, shellParser: parser })
    open.push(ws)
    const sess = ws.createSession('agent')
    sess.visibility = { ...sess.visibility, paths: { patterns: ['*.key'] } }
    const io = await ws.shell('find /a -empty', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('/a/vault')
    expect(out).not.toContain('only.key')
  })

  it('ls of a hidden dir is no such file', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.shell('ls /a/secrets', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('token')
  })

  it('find never reports hidden rows', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.shell('find /a', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('/a/x.txt')
    expect(out).not.toContain('secrets')
    expect(out).not.toContain('.key')
  })

  it('du never counts hidden leaves', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.shell('du -a /a', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('x.txt')
    expect(out).not.toContain('secrets')
    expect(out).not.toContain('.key')
  })

  it('a glob never matches a hidden name', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.shell('cat /a/*.key', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('kkk')
  })

  it('a redirect into hidden space fails and writes nothing', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.shell('echo hi > /a/secrets/new.txt', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    const a = ws.namespace.mountFor('/a/x.txt')
    const vfs = a.vfs as RAMVFS
    expect(vfs.store.files.has('/secrets/new.txt')).toBe(false)
  })

  it('the unscoped session sees everything', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.shell('ls /a')
    const out = stdoutStr(io)
    expect(out).toContain('secrets')
    expect(out).toContain('note.key')
  })

  it('the op facade agrees with the shell', async () => {
    const ws = await makeHiddenPathsWs()
    const sess = ws.getSession('agent')
    await runWithSession(sess, async () => {
      await expect(ws.vfs.read('/a/secrets/token.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      const names = await ws.vfs.readdir('/a')
      expect(names.some((n) => n.includes('secrets'))).toBe(false)
    })
  })
})

describe('session profiles', () => {
  it('a profile applies every narrowing field end to end', async () => {
    const parser = await getTestParser()
    const a = new RAMVFS()
    a.store.files.set('/x.txt', ENC.encode('public\n'))
    a.store.files.set('/secrets/token.txt', ENC.encode('s3cr3t\n'))
    a.store.dirs.add('/secrets')
    const ws = new Workspace({ '/a': a }, { mode: MountMode.WRITE, shellParser: parser })
    open.push(ws)
    const analyst = parseSessionProfile({
      mounts: { '/a': 'write' },
      paths: { hide: ['/a/secrets'] },
      vars: { hide: ['SLACK_TOKEN'] },
      env: { ROLE: 'analyst' },
    })
    const s1 = ws.createSession('agent1', { profile: analyst })
    const s2 = ws.createSession('agent2', { profile: analyst })
    expect(s1.mountModes?.get('/a')).toBe(MountMode.WRITE)
    expect(s1.visibility.paths).toEqual({ paths: ['/a/secrets'], patterns: [] })
    expect(s2.visibility.paths).toEqual(s1.visibility.paths)
    expect(s1.visibility.vars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
    expect(s1.env.ROLE).toBe('analyst')
    const listing = await ws.shell('ls /a', { sessionId: 'agent1' })
    expect(stdoutStr(listing)).not.toContain('secrets')
    const profile = await ws.shell('echo "$ROLE"', { sessionId: 'agent1' })
    expect(stdoutStr(profile)).toBe('analyst\n')
  })

  it('explicit mounts can only weaken a mode, never raise it', async () => {
    // An inline document restricts: a mode both sides state settles at
    // the weaker one, and a mount only the inline document names is
    // narrowed from whatever the workspace gave it, never raised.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMVFS(), '/b': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser },
    )
    open.push(ws)
    const profile = parseSessionProfile({
      mounts: { '/a': 'write' },
      paths: { hide: ['/a/secrets'] },
    })
    const sess = ws.createSession('agent', {
      mounts: { '/a': 'read', '/b': 'read' },
      profile: profile,
    })
    expect(sess.mountModes?.get('/a')).toBe(MountMode.READ)
    expect(sess.mountModes?.get('/b')).toBe(MountMode.READ)
    expect(sess.visibility.paths).toEqual({ paths: ['/a/secrets'], patterns: [] })
    const raised = ws.createSession('wider', { mounts: { '/a': 'rwx' }, profile: profile })
    expect(raised.mountModes?.get('/a')).toBe(MountMode.WRITE)
  })

  it('a named profile is the whole document, unnamed takes the default, unknown throws', async () => {
    // Two profiles, each the whole document it runs under: there is no
    // inheritance, so reading one is reading everything it may do.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMVFS(), '/b': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: parseSessionProfile({
            cwd: '/b',
            env: { PAGER: 'cat' },
            mounts: { '/a': 'rw', '/b': 'rwx' },
          }),
          reviewer: parseSessionProfile({
            cwd: '/b',
            env: { PAGER: 'cat' },
            mounts: { '/a': 'r', '/b': 'rwx' },
            paths: { hide: ['/a/secrets'] },
          }),
        },
      },
    )
    open.push(ws)
    const reviewer = ws.createSession('r', { profile: 'reviewer' })
    expect(reviewer.mountModes?.get('/a')).toBe(MountMode.READ)
    expect(reviewer.visibility.paths).toEqual({ paths: ['/a/secrets'], patterns: [] })
    expect(reviewer.cwd).toBe('/b')
    expect(reviewer.env.PAGER).toBe('cat')
    const dflt = ws.createSession('d')
    expect(dflt.mountModes?.get('/a')).toBe(MountMode.WRITE)
    expect(dflt.visibility.paths).toBeNull()
    expect(dflt.cwd).toBe('/b')
    expect(() => ws.createSession('x', { profile: 'nope' })).toThrow('unknown profile "nope"')
    // An inline document adds to the named profile: the weaker mode wins,
    // hides union, and an allow list there is refused outright.
    const inline = ws.createSession('i', {
      profile: 'reviewer',
      permissions: parseSessionProfile({
        cwd: '/a',
        mounts: { '/a': 'rw' },
        paths: { hide: ['*.key'] },
        vars: { hide: ['AWS_*'] },
      }),
    })
    expect(inline.mountModes?.get('/a')).toBe(MountMode.READ)
    expect(inline.mountModes?.get('/b')).toBe(MountMode.EXEC)
    expect(inline.visibility.paths).toEqual({ paths: ['/a/secrets'], patterns: ['*.key'] })
    expect(() =>
      ws.createSession('wide', {
        profile: 'reviewer',
        permissions: parseSessionProfile({ commands: { allow: ['ls'] } }),
      }),
    ).toThrow('not an allow list')
    expect(inline.visibility.vars).toEqual({ names: [], patterns: ['AWS_*'] })
    expect(inline.cwd).toBe('/a')
    const pwd = await ws.shell('pwd', { sessionId: 'r' })
    expect(stdoutStr(pwd)).toBe('/b\n')
  })

  it('a misspelled document field fails at the parser', () => {
    expect(() => parseSessionProfile({ extends: 'default' })).toThrow('unknown field `extends`')
  })

  it('a profile keeps a mount away by hiding it, not by omitting it', async () => {
    // Omission is not a refusal, so exclusion is a hide: the mount
    // reads as nonexistent rather than as a permission error naming
    // something the profile cannot see.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMVFS(), '/b': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: parseSessionProfile({ mounts: { '/b': 'rwx' }, paths: { hide: ['/a'] } }),
        },
      },
    )
    open.push(ws)
    const listed = await ws.shell('ls /a')
    expect(listed.exitCode).not.toBe(0)
    expect(voicedStderr(listed)).toContain('No such file or directory')
    const root = stdoutStr(await ws.shell('ls /'))
    expect(root).toContain('b')
    expect(root.split(/\s+/)).not.toContain('a')
  })

  it('the workspace names its default profile by name', async () => {
    // `profile:` on the workspace picks which profile shapes a session
    // created without one, including its own.
    const parser = await getTestParser()
    const profiles = {
      default: parseSessionProfile({ mounts: { '/a': 'rw' } }),
      reviewer: parseSessionProfile({ mounts: { '/a': 'r' } }),
    }
    const ws = new Workspace(
      { '/a': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser, profiles, profile: 'reviewer' },
    )
    open.push(ws)
    expect(ws.getSession(ws.defaultSessionId).mountModes?.get('/a')).toBe(MountMode.READ)
    expect(ws.createSession('agent').mountModes?.get('/a')).toBe(MountMode.READ)
    expect(() => new Workspace({ '/a': new RAMVFS() }, { profiles, profile: 'gone' })).toThrow(
      'unknown profile "gone"',
    )
  })

  it('the default profile shapes the workspace session too', async () => {
    // The workspace's own session is a session created without a name,
    // so `profiles.default` reaches it: the primary agent starts in the
    // profile's cwd, sees its exported env and its mount ceilings, and
    // cannot see what it hides. No default profile leaves it as it was.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMVFS(), '/b': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: parseSessionProfile({
            cwd: '/b',
            env: { PAGER: 'cat' },
            mounts: { '/b': 'rwx' },
            paths: { hide: ['/b/vault'] },
          }),
        },
      },
    )
    open.push(ws)
    const dflt = ws.getSession(ws.defaultSessionId)
    expect(dflt.mountModes?.get('/b')).toBe(MountMode.EXEC)
    expect(dflt.mountModes?.has('/a')).toBe(false)
    expect(dflt.visibility.paths).toEqual({ paths: ['/b/vault'], patterns: [] })
    expect(dflt.cwd).toBe('/b')
    expect(stdoutStr(await ws.shell('pwd'))).toBe('/b\n')
    expect(stdoutStr(await ws.shell('echo "$PAGER"'))).toBe('cat\n')
    // A mount the profile does not name is reachable at its own mode: the
    // `mounts` mapping narrows, it is not an allowlist.
    expect((await ws.shell('ls /a')).exitCode).toBe(0)
    expect((await ws.shell('mkdir /b/vault')).exitCode).not.toBe(0)
    const plain = new Workspace({ '/a': new RAMVFS() }, { shellParser: parser })
    open.push(plain)
    const own = plain.getSession(plain.defaultSessionId)
    expect(own.mountModes).toBeNull()
    expect(own.visibility.paths).toBeNull()
  })

  it("a default profile's hides, its own and its mount sections', bind every session", async () => {
    // One document: `paths.hide` at the top and `mounts./repo`'s own,
    // compiled into the one hidden-paths spec every session carries.
    const parser = await getTestParser()
    const repo = new RAMVFS()
    const ws = new Workspace(
      { '/repo': repo, '/other': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: parseSessionProfile({
            paths: { hide: ['/other/finance', '*.key'] },
            // Anchored on purpose: a bare `*.pem` is a name pattern and
            // means the same thing inside a mount section as outside
            // one, so hiding only the repo's copies spells the prefix.
            mounts: { '/repo': { paths: { hide: ['/repo/.env', '/repo/*.pem'] } } },
          }),
        },
      },
    )
    open.push(ws)
    await ws.shell('mkdir -p /repo/certs /other/finance /other/pub')
    await ws.shell(
      "printf 'S=1\\n' > /repo/.env; printf p > /repo/certs/k.pem; printf r > /repo/README",
    )
    await ws.shell('printf v > /other/.env; printf v > /other/x.pem; printf k > /other/pub/b.key')
    const listing = stdoutStr(await ws.shell('ls -a /repo /repo/certs /other /other/pub'))
    expect(listing).toContain('README')
    expect(listing).not.toContain('k.pem')
    expect(listing).not.toContain('finance')
    expect(listing).not.toContain('b.key')
    expect(listing).toContain('x.pem')
    const repoPart = listing.split('/other:')[0]
    expect(repoPart).not.toContain('.env')
    expect(listing.split('/other:')[1]).toContain('.env')
    expect((await ws.shell('cat /repo/.env')).exitCode).not.toBe(0)
    expect(stdoutStr(await ws.shell('cat /other/.env'))).toBe('v')
    const late = ws.createSession('late')
    expect((await ws.shell('cat /other/pub/b.key', { sessionId: 'late' })).exitCode).not.toBe(0)
    // The profile is the session's own document now, so its hides are on
    // the session rather than bound beside it.
    expect(late.visibility.paths?.paths).toContain('/other/finance')
  })
})

describe('command permissions end to end', () => {
  // One mount section, written the same way by both profiles below: rules
  // here reach a line that works inside /repo, by cwd or by operand,
  // which is what a path-scoped rule cannot express (`cd /repo && git
  // commit` names no path).
  const REPO_SECTION = {
    commands: {
      deny: [{ reason: 'history is read-only here', commands: ['git commit', 'git reset --hard'] }],
    },
  }
  const COMMANDS_DOC = parseSessionProfile({
    commands: {
      allow: [
        'ls',
        'cat',
        'echo',
        'rm',
        'git',
        'python3',
        'mkdir',
        'touch',
        'head',
        'xargs',
        'wc',
        'man',
        'find',
        'type',
        'command',
        'which',
        'cd',
        '[',
      ],
      deny: [
        { reason: 'no deletes in the repo', commands: { rm: ['/repo/*'] } },
        { reason: 'frozen', paths: ['/repo/locked/*'] },
      ],
    },
    mounts: { '/repo': REPO_SECTION },
  })
  const REVIEWER: SessionProfile = parseSessionProfile({
    commands: {
      allow: ['ls', 'cat', 'echo', 'git log', 'git status', 'xargs', 'type', 'eval'],
    },
    mounts: { '/repo': REPO_SECTION },
  })

  async function commandsWs(): Promise<Workspace> {
    const parser = await getTestParser()
    // The frozen subtree is seeded on the VFS: the pure path rule
    // holds at every op door, the host's `ws.vfs` included.
    const repo = new RAMVFS()
    repo.store.dirs.add('/locked')
    repo.store.files.set('/locked/y', ENC.encode('y\n'))
    const ws = new Workspace(
      { '/repo': repo, '/scratch': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: { default: COMMANDS_DOC, reviewer: REVIEWER },
      },
    )
    open.push(ws)
    ws.registerCli('git', cliSpecFor('git'))
    return ws
  }

  async function line(
    ws: Workspace,
    text: string,
    sessionId?: string,
  ): Promise<[number, string, string]> {
    const r = await ws.shell(text, sessionId === undefined ? {} : { sessionId })
    return [r.exitCode, stdoutStr(r), voicedStderr(r)]
  }

  it('an allow list hides unlisted tools from dispatch and the enumerators', async () => {
    const ws = await commandsWs()
    await ws.shell('mkdir -p /repo/d && touch /repo/d/x')
    // An unlisted tool is not a command for the session: 127 before any
    // admission hook, and every enumerator agrees.
    expect(await line(ws, 'sort /repo/d/x')).toEqual([127, '', 'sort: command not found\n'])
    expect(await line(ws, 'type sort; echo $?')).toEqual([
      0,
      '1\n',
      'bash: type: sort: not found\n',
    ])
    expect(await line(ws, 'command -v sort; echo $?')).toEqual([0, '1\n', ''])
    expect(await line(ws, 'which sort; echo $?')).toEqual([0, '1\n', ''])
    const [code, out] = await line(ws, 'man')
    expect(code).toBe(0)
    expect(out).toContain('- cat')
    expect(out).not.toContain('- sort')
    expect((await line(ws, 'man sort'))[0]).toBe(1)
    // Builtins are subjects like everything else: the listed cd and [
    // run, the unlisted pwd and history are not commands at all.
    // Functions are the one exemption, and every line of a body passes
    // the gate itself.
    expect(await line(ws, 'cd /repo && [ -f d/x ] && echo yes')).toEqual([0, 'yes\n', ''])
    expect(await line(ws, 'f() { echo in-f; }; f')).toEqual([0, 'in-f\n', ''])
    expect((await line(ws, 'cat /repo/d/x'))[0]).toBe(0)
    expect(await line(ws, 'pwd')).toEqual([127, '', 'pwd: command not found\n'])
    expect(await line(ws, 'type pwd; echo $?')).toEqual([0, '1\n', 'bash: type: pwd: not found\n'])
    // `history` is a tool-tier builtin: hidden when unlisted.
    expect(await line(ws, 'history')).toEqual([127, '', 'history: command not found\n'])
  })

  it("a profile's allow list is the only one a session reads", async () => {
    const ws = await commandsWs()
    ws.createSession('rev', { profile: 'reviewer' })
    await ws.shell('mkdir -p /repo/d && touch /repo/d/x')
    // The reviewer profile lists `cat` and not python3, whatever the
    // default profile lists; it lists `git log`, so `git` is visible but a
    // `git commit` line is covered by nothing (a refusal that names the
    // program, not "command not found").
    expect((await line(ws, 'cat /repo/d/x', 'rev'))[0]).toBe(0)
    expect(await line(ws, 'python3 -c 1', 'rev')).toEqual([127, '', 'python3: command not found\n'])
    expect((await line(ws, 'type git', 'rev'))[0]).toBe(0)
    expect(await line(ws, 'git commit -m x', 'rev')).toEqual([
      126,
      '',
      'git: Permission denied\npolicy denied: git commit is not allowed\n',
    ])
    // The verb walk normalizes the line: options before the verb are
    // not the verb, so `git -C /repo status` is `git status`.
    expect((await line(ws, 'git -C /repo status', 'rev'))[2]).not.toContain('not allowed')
    // Nested runners re-enter the chokepoint: the hidden `rm` stays
    // hidden inside xargs (which, as GNU's, finds no such program), eval
    // and a function body.
    expect(await line(ws, 'echo /repo/d/x | xargs rm', 'rev')).toEqual([
      127,
      '',
      'xargs: rm: No such file or directory\n',
    ])
    expect(await line(ws, "eval 'rm /repo/d/x'", 'rev')).toEqual([
      127,
      '',
      'rm: command not found\n',
    ])
    expect(await line(ws, 'f() { rm /repo/d/x; }; f', 'rev')).toEqual([
      127,
      '',
      'rm: command not found\n',
    ])
    // An inline document may add rules, never an allow list.
    expect(() =>
      ws.createSession('tight', {
        profile: 'reviewer',
        permissions: parseSessionProfile({ commands: { allow: ['cat', 'git'] } }),
      }),
    ).toThrow('not an allow list')
    ws.createSession('tight', {
      profile: 'reviewer',
      permissions: parseSessionProfile({ commands: { deny: ['ls'] } }),
    })
    expect((await line(ws, 'cat /repo/d/x', 'tight'))[0]).toBe(0)
    expect(await line(ws, 'ls /repo', 'tight')).toEqual([
      126,
      '',
      'ls: Permission denied\npolicy denied: denied by policy\n',
    ])
    expect((await line(ws, 'git log', 'tight'))[2]).not.toContain('not allowed')
  })

  it('deny rules by scope, voice and where they were written', async () => {
    const ws = await commandsWs()
    await ws.shell('mkdir -p /repo/d && touch /repo/d/x /scratch/z')
    // Operand-scoped: the GNU voice at 1, the operand as typed.
    expect(await line(ws, 'cd /repo/d && rm x')).toEqual([
      1,
      '',
      "rm: cannot remove 'x': Permission denied\npolicy denied: no deletes in the repo\n",
    ])
    expect((await line(ws, 'rm /scratch/z'))[0]).toBe(0)
    // A pure path rule holds at the command plane for any command and
    // at the op door for every op, whatever door.
    expect(await line(ws, 'cat /repo/locked/y')).toEqual([
      1,
      '',
      'cat: /repo/locked/y: Permission denied\npolicy denied: frozen\n',
    ])
    await expect(ws.vfs.write('/repo/locked/y', 'changed')).rejects.toThrow()
    await expect(ws.vfs.read('/repo/locked/y')).rejects.toThrow()
    // A mount section's rule applies when the line works inside the
    // mount (cwd under it, or a path under it), whole command; the verb
    // walk reads `-C /repo reset --hard` as `git reset --hard`.
    expect(await line(ws, 'cd /repo && git commit -m x')).toEqual([
      126,
      '',
      'git: Permission denied\npolicy denied: history is read-only here\n',
    ])
    expect(await line(ws, 'cd /scratch && git -C /repo reset --hard')).toEqual([
      126,
      '',
      'git: Permission denied\npolicy denied: history is read-only here\n',
    ])
    expect((await line(ws, 'cd /scratch && git commit -m x'))[2]).not.toContain('read-only')
    expect((await line(ws, 'cd /repo && git reset --soft HEAD'))[2]).not.toContain('read-only')
  })

  it('find -delete is gated at the op door, not by a named rule', async () => {
    // mirage's find has no -exec; -delete is find's own action, not an
    // `rm` line, so a rule naming `rm` does not cover it (the same
    // honest limit as a guest's os.remove), while a pure path rule does,
    // at the op door the removal clears.
    const ws = await commandsWs()
    await ws.shell('mkdir -p /repo/d && touch /repo/d/x')
    await ws.shell('find /repo/d -name x -delete')
    expect((await line(ws, 'cat /repo/d/x'))[0]).not.toBe(0)
    expect(await line(ws, 'find /repo/locked -name y -delete')).toEqual([
      1,
      '',
      "find: cannot delete '/repo/locked/y': Permission denied\npolicy denied: frozen\n",
    ])
    expect((await line(ws, 'cat /repo/locked/y'))[0]).toBe(1)
  })

  it('a command-scoped path rule reads the path the command touches', async () => {
    // A command-scoped rule never runs at the op door, so the command
    // plane has to see the path the command will actually touch: for a
    // command that follows links (open(2)) that is the target, for one
    // that acts on the link itself (rm, lstat(2)) it is the link.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: parseSessionProfile({
            commands: {
              deny: [
                { reason: 'sealed', commands: { cat: ['/data/secret*'], head: ['/data/secret*'] } },
                { reason: 'keep the link', commands: { rm: ['/data/link'] } },
              ],
            },
          }),
        },
      },
    )
    open.push(ws)
    await ws.shell(
      'echo top > /data/secret && ln -s /data/secret /data/link && ln -s /data/secret /data/other',
    )
    expect(await line(ws, 'cat /data/secret')).toEqual([
      1,
      '',
      'cat: /data/secret: Permission denied\npolicy denied: sealed\n',
    ])
    // Through the link: refused, the operand named as typed.
    expect(await line(ws, 'cat /data/link')).toEqual([
      1,
      '',
      'cat: /data/link: Permission denied\npolicy denied: sealed\n',
    ])
    expect(await line(ws, 'head -n 1 /data/other')).toEqual([
      1,
      '',
      "head: cannot open '/data/other' for reading: Permission denied\npolicy denied: sealed\n",
    ])
    // rm removes the link, not the target: the target's rule does not
    // apply, the link's own does.
    expect(await line(ws, 'rm /data/other')).toEqual([0, '', ''])
    expect(await line(ws, 'rm /data/link')).toEqual([
      1,
      '',
      "rm: cannot remove '/data/link': Permission denied\npolicy denied: keep the link\n",
    ])
    expect((await line(ws, 'cat /data/link'))[0]).toBe(1)
  })

  it('redirect targets are judged with the line', async () => {
    // The shell reads `<` and writes `>` on its own fds, outside the
    // admitted command's gate window, so the targets are judged at the
    // line's admission: the refused read never happens and the refused
    // write never truncates.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: parseSessionProfile({
            commands: {
              deny: [
                { reason: 'sealed', commands: { cat: ['/data/secret*'] } },
                { reason: 'audit is append-only', commands: { echo: ['/data/audit.log'] } },
              ],
            },
          }),
        },
      },
    )
    open.push(ws)
    await ws.shell("echo top > /data/secret && printf 'one\\n' > /data/audit.log")
    expect(await line(ws, 'cat < /data/secret')).toEqual([
      1,
      '',
      'cat: /data/secret: Permission denied\npolicy denied: sealed\n',
    ])
    expect(await line(ws, 'echo two > /data/audit.log')).toEqual([
      1,
      '',
      'echo: /data/audit.log: Permission denied\npolicy denied: audit is append-only\n',
    ])
    // The refused write did not truncate, and clean redirects run.
    expect(await line(ws, 'cat /data/audit.log')).toEqual([0, 'one\n', ''])
    expect(await line(ws, 'cat < /data/audit.log')).toEqual([0, 'one\n', ''])
    expect(await line(ws, 'echo ok > /data/out && cat < /data/out')).toEqual([0, 'ok\n', ''])
  })

  it('a mount rule speaks on a walk from above', async () => {
    // `grep -r x /scratch` enters /scratch/child: the fan-out reruns
    // the traversal inside each descendant mount and no admission fires
    // again there, so the child mount's rule must speak on the ancestor
    // operand. A walk elsewhere, or a non-recursive read of the parent,
    // is not its business.
    const parser = await getTestParser()
    const ws = new Workspace(
      {
        '/scratch': new RAMVFS(),
        '/scratch/child': new RAMVFS(),
        '/elsewhere': new RAMVFS(),
      },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: parseSessionProfile({
            mounts: {
              '/scratch/child': {
                commands: { deny: [{ reason: 'boxed', commands: ['grep'] }] },
              },
            },
          }),
        },
      },
    )
    open.push(ws)
    await ws.shell('echo x > /scratch/a && echo x > /elsewhere/a && echo x > /scratch/child/c')
    expect(await line(ws, 'grep -r x /scratch')).toEqual([
      126,
      '',
      'grep: Permission denied\npolicy denied: boxed\n',
    ])
    expect(await line(ws, 'grep -r x /elsewhere')).toEqual([0, '/elsewhere/a:x\n', ''])
    // Inside the mount the rule needs no ancestor help.
    expect(await line(ws, 'grep x /scratch/child/c')).toEqual([
      126,
      '',
      'grep: Permission denied\npolicy denied: boxed\n',
    ])
    // A non-recursive grep of the parent never enters the child.
    const [dirCode, , dirErr] = await line(ws, 'grep x /scratch')
    expect(dirCode).toBe(2)
    expect(dirErr).toContain('Is a directory')
  })

  it('a whole-line runtime is gated like the tree', async () => {
    // A runtime that captures the raw line runs it under the same
    // tiers: every parsed command clears visibility, the policy chain
    // and the approval door before the runtime sees a byte, so a
    // captured line cannot run what the tree would refuse.
    const parser = await getTestParser()
    const box = new Box()
    const ws = new Workspace(
      { '/repo': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: { default: COMMANDS_DOC, reviewer: REVIEWER },
        runtimes: [box, 'workspace'],
      },
    )
    open.push(ws)
    ws.registerCli('git', cliSpecFor('git'))
    expect(await line(ws, 'sort /repo/x')).toEqual([127, '', 'sort: command not found\n'])
    expect(await line(ws, 'cat /repo/a | sort')).toEqual([127, '', 'sort: command not found\n'])
    expect(await line(ws, 'rm /repo/x')).toEqual([
      1,
      '',
      "rm: cannot remove '/repo/x': Permission denied\npolicy denied: no deletes in the repo\n",
    ])
    expect(await line(ws, 'cat /repo/a; rm -f /repo/x')).toEqual([
      1,
      '',
      "rm: cannot remove '/repo/x': Permission denied\npolicy denied: no deletes in the repo\n",
    ])
    expect(box.lines).toEqual([])
    expect(await line(ws, 'cat /repo/a | wc -l')).toEqual([0, 'box:cat /repo/a | wc -l', ''])
    ws.createSession('rev', { profile: 'reviewer' })
    expect(await line(ws, 'git add x', 'rev')).toEqual([
      126,
      '',
      'git: Permission denied\npolicy denied: git add is not allowed\n',
    ])
    expect((await line(ws, 'git status', 'rev'))[0]).toBe(0)
    expect(box.lines).toEqual(['cat /repo/a | wc -l', 'git status'])
  })

  it('a whole-line runtime reads only literal words', async () => {
    // The runtime expands the line, so the gate reads it as typed and
    // refuses what only the runtime could read where a rule in force
    // would have read it: the command name under any rule, an argument
    // where a rule reads that command's arguments, and a line a word
    // runs that the gate cannot see into.
    const parser = await getTestParser()
    const box = new Box()
    const ws = new Workspace(
      { '/repo': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: parseSessionProfile({
            commands: {
              deny: [
                { reason: 'no deletes', commands: ['rm'] },
                { reason: 'sealed', commands: { cat: ['/repo/secret*'] } },
                { reason: 'no pushes', commands: ['git push'] },
              ],
            },
          }),
        },
        runtimes: [box, 'workspace'],
      },
    )
    open.push(ws)
    ws.registerCli('git', cliSpecFor('git'))
    const unread = (raw: string) =>
      `Permission denied\npolicy denied: cannot read ${raw} before the runtime expands it\n`
    expect(await line(ws, 'rm /repo/x')).toEqual([
      126,
      '',
      'rm: Permission denied\npolicy denied: no deletes\n',
    ])
    expect(await line(ws, '$cmd /repo/x')).toEqual([126, '', '$cmd: ' + unread('$cmd')])
    expect(await line(ws, 'PAYLOAD=\'rm /repo/x\'; eval "$PAYLOAD"')).toEqual([
      126,
      '',
      '"$PAYLOAD": ' + unread('"$PAYLOAD"'),
    ])
    expect(await line(ws, "eval 'rm /repo/x'")).toEqual([
      126,
      '',
      'rm: Permission denied\npolicy denied: no deletes\n',
    ])
    expect(await line(ws, 'cat "$f"')).toEqual([126, '', 'cat: ' + unread('"$f"')])
    expect(await line(ws, 'git "$verb" origin')).toEqual([126, '', 'git: ' + unread('"$verb"')])
    expect(await line(ws, 'ls /repo | xargs rm')).toEqual([
      126,
      '',
      'rm: Permission denied\npolicy denied: no deletes\n',
    ])
    expect(await line(ws, 'ls /repo | xargs cat')).toEqual([
      126,
      '',
      'cat: Permission denied\npolicy denied: runs on operands the gate cannot read\n',
    ])
    expect(await line(ws, 'source /repo/env.sh')).toEqual([
      126,
      '',
      'source: Permission denied\npolicy denied: runs lines the gate cannot read\n',
    ])
    expect(await line(ws, "sh -c 'timeout 5 rm /repo/x'")).toEqual([
      126,
      '',
      'rm: Permission denied\npolicy denied: no deletes\n',
    ])
    expect(await line(ws, "builtin eval 'rm /repo/x'")).toEqual([
      126,
      '',
      'rm: Permission denied\npolicy denied: no deletes\n',
    ])
    expect(box.lines).toEqual([])
    // Literal words, and dynamic ones no rule reads, reach the runtime.
    const passing = [
      'echo "$HOME" $(date)',
      'git status',
      "'cat' /repo/a",
      'ls | xargs echo',
      'command -v rm',
    ]
    for (const text of passing) expect((await line(ws, text))[0]).toBe(0)
    expect(box.lines).toEqual(passing)
  })

  it('a bare listing in a ruled directory is refused', async () => {
    // `ls`, `find`, `du`, `tree` and `grep -r` typed bare read the
    // working directory: the executor injects that operand after the
    // gate, so the gate supplies it itself, typed as `.`.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/repo': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: parseSessionProfile({
            commands: {
              deny: [
                {
                  reason: 'sealed',
                  commands: {
                    ls: ['/repo/sealed'],
                    find: ['/repo/sealed'],
                    grep: ['/repo/sealed'],
                  },
                },
              ],
            },
          }),
        },
      },
    )
    open.push(ws)
    await ws.shell('mkdir -p /repo/sealed && echo x > /repo/sealed/f')
    expect(await line(ws, 'ls /repo/sealed')).toEqual([
      1,
      '',
      "ls: cannot access '/repo/sealed': Permission denied\npolicy denied: sealed\n",
    ])
    expect(await line(ws, 'cd /repo/sealed && ls')).toEqual([
      1,
      '',
      "ls: cannot access '.': Permission denied\npolicy denied: sealed\n",
    ])
    expect(await line(ws, 'cd /repo/sealed && find -name f')).toEqual([
      1,
      '',
      "find: '.': Permission denied\npolicy denied: sealed\n",
    ])
    expect(await line(ws, 'cd /repo/sealed && grep -r x')).toEqual([
      1,
      '',
      'grep: /repo/sealed: Permission denied\npolicy denied: sealed\n',
    ])
    // With an operand, or without the recursion that reads the
    // directory, nothing is implied.
    expect(await line(ws, 'cd /repo/sealed && ls /repo')).toEqual([0, 'sealed\n', ''])
    expect(await line(ws, 'cd /repo/sealed && echo x | grep x')).toEqual([0, 'x\n', ''])
  })

  it('a hidden path reads as absent to every rule', async () => {
    // hide outranks every admission arm: a path the session cannot see
    // is dropped before any hook, so a deny never names it, an ask is
    // never raised for it, and the door answers ENOENT as for any
    // absent path. The same lines under a session that sees them meet
    // the rules as usual.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/repo': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: parseSessionProfile({
            commands: {
              allow: ['mkdir', 'echo', 'touch', 'cat', 'rm', 'ls', 'head'],
              ask: [{ reason: 'sign-off', commands: { rm: ['/repo/shared/*'] } }],
              deny: [
                { reason: 'private', commands: { cat: ['/repo/private'] } },
                { reason: 'sealed', paths: ['/repo/sealed/*'] },
                { reason: 'no heads', commands: ['head'] },
              ],
            },
          }),
        },
      },
    )
    open.push(ws)
    await ws.shell(
      'mkdir -p /repo/private /repo/shared && echo k > /repo/private/k && touch /repo/shared/a',
    )
    ws.createSession('veiled', {
      permissions: parseSessionProfile({
        paths: { hide: ['/repo/private', '/repo/shared', '/repo/sealed'] },
      }),
    })
    expect(await line(ws, 'cat /repo/private/k')).toEqual([
      1,
      '',
      'cat: /repo/private/k: Permission denied\npolicy denied: private\n',
    ])
    expect(await line(ws, 'cat /repo/private/k', 'veiled')).toEqual([
      1,
      '',
      'cat: /repo/private/k: No such file or directory\n',
    ])
    expect(await line(ws, 'cat /repo/sealed/x')).toEqual([
      1,
      '',
      'cat: /repo/sealed/x: Permission denied\npolicy denied: sealed\n',
    ])
    expect(await line(ws, 'cat /repo/sealed/x', 'veiled')).toEqual([
      1,
      '',
      'cat: /repo/sealed/x: No such file or directory\n',
    ])
    const [code, , err] = await line(ws, 'rm /repo/shared/a')
    expect(code).toBe(126)
    expect(err.startsWith('rm: Permission denied\nrequires approval: sign-off')).toBe(true)
    expect(await line(ws, 'rm /repo/shared/a', 'veiled')).toEqual([
      1,
      '',
      "rm: cannot remove '/repo/shared/a': No such file or directory\n",
    ])
    expect(ws.decisions.pending().map((r) => r.sessionId)).toEqual([ws.sessionManager.defaultId])
    expect(await line(ws, 'ls /repo', 'veiled')).toEqual([0, '', ''])
    // A rule with no path in it still speaks: nothing hidden is named.
    expect(await line(ws, 'head /repo/private/k', 'veiled')).toEqual([
      126,
      '',
      'head: Permission denied\npolicy denied: no heads\n',
    ])
  })
})

/** A runtime that takes every line raw, recording what reached it. */
class Box extends Runtime implements LineExecutor {
  readonly [LINE_EXECUTOR] = true as const
  readonly name = 'box'
  lines: string[] = []

  constructor() {
    super({ captures: ['*'] })
  }

  runLine(
    line: string,
    _stdin: Uint8Array | null,
    _env: Record<string, string>,
    _cwd: string,
  ): Promise<RunResult> {
    this.lines.push(line)
    return Promise.resolve({ stdout: ENC.encode(`box:${line}`), stderr: null, exitCode: 0 })
  }
}

describe('ask end to end', () => {
  // Through the document parser, as the YAML door reads it: a bare
  // string under `ask` is one pattern with the default reason.
  const ASK_DOC = parseSessionProfile({
    commands: {
      ask: [{ reason: 'sign-off', commands: ['rm'] }, 'head'],
      deny: [{ reason: 'no deletes in the repo', commands: { rm: ['/repo/*'] } }],
    },
  })

  // A coded condition that asks: every wc line.
  class AskWc implements Policy {
    preCommand(ctx: CommandContext): Action | null {
      if (ctx.command === 'wc') return { kind: 'ask', reason: 'looks risky' }
      return null
    }
  }

  async function askWs(options: { onAsk?: AskHandler } = {}): Promise<Workspace> {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/repo': new RAMVFS(), '/scratch': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: { default: ASK_DOC },
        policies: [new AskWc()],
        ...(options.onAsk !== undefined ? { onAsk: options.onAsk } : {}),
      },
    )
    open.push(ws)
    return ws
  }

  async function line(
    ws: Workspace,
    text: string,
    sessionId?: string,
  ): Promise<[number, string, string]> {
    const r = await ws.shell(text, sessionId === undefined ? {} : { sessionId })
    return [r.exitCode, stdoutStr(r), voicedStderr(r)]
  }

  // The one request a step expects on the door; a missing one is the
  // test's failure, not a type to thread through.
  function pendingRequest(ws: Workspace, command?: string): Decision {
    const found = ws.decisions.pending().find((r) => command === undefined || r.command === command)
    if (found === undefined) throw new Error(`no pending approval for ${command ?? 'any command'}`)
    return found
  }

  it('an asked line is refused until the host answers', async () => {
    const ws = await askWs()
    await ws.shell('mkdir -p /repo/d && touch /repo/d/x /scratch/z')
    // Asked: 126 in the requires-approval voice, quoting an id; the
    // request is on ws.decisions with what was asked; a retry quotes the
    // same id and adds nothing.
    const [code, , err] = await line(ws, 'rm /scratch/z')
    expect(code).toBe(126)
    const request = pendingRequest(ws)
    expect(err).toBe(`rm: Permission denied\nrequires approval: sign-off (ask ${request.id})\n`)
    expect([request.command, request.argv, request.cwd, request.paths]).toEqual([
      'rm',
      ['/scratch/z'],
      '/',
      ['/scratch/z'],
    ])
    expect(request.sessionId).toBe(ws.sessionManager.defaultId)
    expect(await line(ws, 'rm /scratch/z')).toEqual([126, '', err])
    expect(ws.decisions.pending()).toHaveLength(1)
    // The request names the agent of the call that asked, not the
    // workspace's constructor agent, so a shared workspace attributes
    // an approval to whoever raised it.
    expect(request.agentId).toBe('')
    const byBob = await ws.shell('rm /scratch/z2', { agentId: 'bob' })
    expect(byBob.exitCode).toBe(126)
    expect(ws.decisions.pending().map((r) => r.agentId)).toEqual(['', 'bob'])
    // The agent rides with the execution, not the workspace: a line
    // asked through a nested eval keeps its caller's, and two lines in
    // flight at once keep their own.
    // The substitution's own command is a command of the line, so the
    // line is refused whole rather than running `echo` over an empty
    // substitution and exiting 0, which used to leave the agent reading
    // success for a removal that never happened.
    const nested = await ws.shell('echo $(rm /scratch/z3)', { agentId: 'carol' })
    expect(nested.exitCode).toBe(126)
    await Promise.all([
      ws.shell('rm /scratch/z4', { agentId: 'dan' }),
      ws.shell("eval 'rm /scratch/z5'", { agentId: 'eve' }),
    ])
    const byAgent = Object.fromEntries(
      ws.decisions.pending().map((r) => [[r.command, ...r.argv].join(' '), r.agentId]),
    )
    expect(byAgent).toEqual({
      'rm /scratch/z': '',
      'rm /scratch/z2': 'bob',
      'rm /scratch/z3': 'carol',
      'rm /scratch/z4': 'dan',
      'rm /scratch/z5': 'eve',
    })
    for (const r of ws.decisions.pending()) {
      if (r.agentId !== '' && r.agentId !== 'bob') await ws.decisions.answer(r.id, Outcome.DENY)
    }
    const bobs = ws.decisions.pending().find((r) => r.agentId === 'bob')
    if (bobs === undefined) throw new Error('no request from bob')
    await ws.decisions.answer(bobs.id, Outcome.DENY)
    // Granted once: the exact retry passes, and the next one asks.
    await ws.decisions.answer(request.id, Outcome.ALLOW)
    expect(ws.decisions.pending()).toEqual([])
    expect((await line(ws, 'rm /scratch/z'))[0]).toBe(0)
    expect((await line(ws, 'cat /scratch/z'))[0]).toBe(1)
    const again = await line(ws, 'rm /scratch/z')
    expect(again[0]).toBe(126)
    expect(again[2]).toContain('requires approval')
    // A bare pattern asks with the default reason.
    const asked = await line(ws, 'head /repo/d/x')
    expect(asked[0]).toBe(126)
    expect(
      asked[2].startsWith('head: Permission denied\nrequires approval: no standing approval'),
    ).toBe(true)
    // Denied: the retry is refused once in the deny voice, then the
    // question is open again.
    await ws.decisions.answer(pendingRequest(ws, 'head').id, Outcome.DENY)
    expect(await line(ws, 'head /repo/d/x')).toEqual([
      126,
      '',
      'head: Permission denied\npolicy denied: no standing approval\n',
    ])
    const reasked = await line(ws, 'head /repo/d/x')
    expect(reasked[0]).toBe(126)
    expect(reasked[2]).toContain('requires approval')
  })

  it('a session grant covers the rule and a deny is never re-opened', async () => {
    const ws = await askWs()
    await ws.shell('mkdir -p /repo/d && touch /repo/d/x /scratch/y /scratch/z')
    expect((await line(ws, 'rm /scratch/y'))[0]).toBe(126)
    await ws.decisions.answer(pendingRequest(ws).id, Outcome.ALLOW, Scope.SESSION)
    // Every rm line passes now, in any directory of the session ...
    expect((await line(ws, 'rm /scratch/y'))[0]).toBe(0)
    expect((await line(ws, 'cd /scratch && rm z'))[0]).toBe(0)
    // ... except where a deny rule speaks: the deny arm runs before the
    // ask arm, so no grant can re-open it, and the denied line raises no
    // request (nothing for the host to answer; the battery cannot see
    // this, so it is pinned here).
    expect(await line(ws, 'cd /repo/d && rm x')).toEqual([
      1,
      '',
      "rm: cannot remove 'x': Permission denied\npolicy denied: no deletes in the repo\n",
    ])
    expect(ws.decisions.pending()).toEqual([])
    // The grant is session state: on the record, and not another
    // session's.
    const record = ws.sessionManager.get(ws.sessionManager.defaultId).toJSON() as {
      decisions: { outcome: string; scope: string }[]
    }
    expect(record.decisions[0]?.scope).toBe('session')
    ws.createSession('other')
    await ws.shell('touch /scratch/w', { sessionId: 'other' })
    const other = await line(ws, 'rm /scratch/w', 'other')
    expect(other[0]).toBe(126)
    expect(other[2]).toContain('requires approval')
  })

  it('a coded ask routes to the same door', async () => {
    const ws = await askWs()
    await ws.shell('touch /scratch/z')
    const [code, , err] = await line(ws, 'wc -c /scratch/z')
    expect(code).toBe(126)
    const request = pendingRequest(ws)
    expect(err).toBe(`wc: Permission denied\nrequires approval: looks risky (ask ${request.id})\n`)
    // The synthesized rule names the program, so a session grant covers
    // every wc line.
    expect(request.rule).toEqual({ reason: 'looks risky', commands: ['wc'] })
    await ws.decisions.answer(request.id, Outcome.ALLOW, Scope.SESSION)
    expect(await line(ws, 'wc -c /scratch/z')).toEqual([0, '0 /scratch/z\n', ''])
    expect(await line(ws, 'wc -l /scratch/z')).toEqual([0, '0 /scratch/z\n', ''])
  })

  it('a grant is consumed through a fork', async () => {
    const ws = await askWs()
    await ws.shell('touch /scratch/z')
    expect((await line(ws, 'rm /scratch/z'))[0]).toBe(126)
    await ws.decisions.answer(pendingRequest(ws).id, Outcome.ALLOW)
    // execute({env}) runs the line in a fork of the session: the once
    // grant is read and consumed through the manager, so the fork
    // spends it for the session it forked from.
    const forked = await ws.shell('rm /scratch/z', { env: { X: '1' } })
    expect(forked.exitCode).toBe(0)
    const again = await line(ws, 'rm /scratch/z')
    expect(again[0]).toBe(126)
    expect(again[2]).toContain('requires approval')
  })

  it('a blocking host answers inside the line', async () => {
    // The host is a plain function over the ledger's own record, not a
    // class implementing a protocol: it answers by returning the record
    // with an outcome set.
    const allowOnce = (r: Decision): Promise<Decision> =>
      Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    const denyIt = (r: Decision): Promise<Decision> =>
      Promise.resolve({ ...r, outcome: Outcome.DENY })
    const yes = await askWs({ onAsk: allowOnce })
    await yes.shell('touch /scratch/z')
    expect((await line(yes, 'rm /scratch/z'))[0]).toBe(0)
    expect(yes.decisions.pending()).toEqual([])
    const no = await askWs({ onAsk: denyIt })
    await no.shell('touch /scratch/z')
    expect(await line(no, 'rm /scratch/z')).toEqual([
      126,
      '',
      'rm: Permission denied\npolicy denied: sign-off\n',
    ])
    expect((await line(no, 'cat /scratch/z'))[0]).toBe(0)
  })
})

describe('a walk below the operand meets the rule guard', () => {
  const WALK_DOC: SessionProfile = parseSessionProfile({
    paths: { hide: ['/data/t/ghost'] },
    commands: {
      allow: [
        'mkdir',
        'echo',
        'ls',
        'cat',
        'grep',
        'find',
        'du',
        'cp',
        'tar',
        'tree',
        'stat',
        'rm',
        'test',
      ],
      ask: [{ reason: 'nod', commands: { grep: ['/data/t/asked/*'] } }],
      deny: [
        { reason: 'private', commands: { grep: ['/data/t/private'], ls: ['/data/t/private'] } },
        { reason: 'sealed', paths: ['/data/t/sealed'] },
        { reason: 'frozen', paths: ['/data/t/locked/*'] },
      ],
    },
  })

  // The rules live on a profile so the tree can be seeded under the
  // unrestricted default session; every probe runs as "g".
  async function walkWs(): Promise<Workspace> {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser, profiles: { guarded: WALK_DOC } },
    )
    open.push(ws)
    ws.createSession('g', { profile: 'guarded' })
    await ws.shell(
      'mkdir -p /data/t/private /data/t/sealed/deep /data/t/locked ' +
        '/data/t/open /data/t/asked /data/t/ghost && ' +
        'echo k > /data/t/private/k && echo s > /data/t/sealed/s && ' +
        'echo d > /data/t/sealed/deep/d && echo y > /data/t/locked/y && ' +
        'echo o > /data/t/open/o && echo a > /data/t/asked/a && ' +
        'echo g > /data/t/ghost/g',
    )
    return ws
  }

  async function line(ws: Workspace, text: string): Promise<[number, string, string]> {
    const r = await ws.shell(text, { sessionId: 'g' })
    return [r.exitCode, stdoutStr(r), voicedStderr(r)]
  }

  it('each walker reports the refusal the way GNU reports an unreadable entry', async () => {
    const ws = await walkWs()
    const [grepCode, grepOut, grepErr] = await line(ws, 'grep -r . /data/t')
    expect(grepCode).toBe(2)
    expect(grepOut).toBe('/data/t/open/o:o\n')
    expect(grepErr).toBe(
      'grep: /data/t/asked/a: Permission denied\n' +
        'grep: /data/t/locked/y: Permission denied\n' +
        'grep: /data/t/private: Permission denied\n' +
        'grep: /data/t/sealed: Permission denied\n' +
        'policy denied: sealed\n',
    )
    const [lsCode, lsOut, lsErr] = await line(ws, 'ls -R /data/t')
    expect(lsCode).toBe(1)
    expect(lsOut).toContain('locked:\ny\n')
    expect(lsOut).not.toContain('ghost')
    expect(lsErr).toBe(
      "ls: cannot open directory '/data/t/private': Permission denied\n" +
        "ls: cannot open directory '/data/t/sealed': Permission denied\n" +
        'policy denied: sealed\n',
    )
    const [findCode, findOut, findErr] = await line(ws, "find /data/t -name '*'")
    expect(findCode).toBe(1)
    expect(findOut).toContain('/data/t/sealed\n')
    expect(findOut).not.toContain('/data/t/sealed/s')
    expect(findOut).toContain('/data/t/locked/y\n')
    expect(findErr).toBe("find: '/data/t/sealed': Permission denied\npolicy denied: sealed\n")
    const [duCode, duOut, duErr] = await line(ws, 'du -a /data/t')
    expect(duCode).toBe(1)
    expect(duOut).toContain('2\t/data/t/locked/y\n')
    // GNU still prints the row of a directory it may not open, at 0.
    expect(duOut).toContain('0\t/data/t/sealed\n')
    expect(duOut).not.toContain('/data/t/sealed/')
    expect(duErr).toBe(
      "du: cannot read directory '/data/t/sealed': Permission denied\npolicy denied: sealed\n",
    )
    const [cpCode, , cpErr] = await line(ws, 'cp -r /data/t /data/copy')
    expect(cpCode).toBe(1)
    expect(cpErr).toBe(
      "cp: cannot access '/data/t/sealed': Permission denied\n" +
        "cp: cannot open '/data/t/locked/y' for reading: Permission denied\n" +
        'policy denied: frozen\n',
    )
    expect((await line(ws, 'cat /data/copy/private/k'))[1]).toBe('k\n')
    expect((await line(ws, 'test -d /data/copy/sealed'))[0]).toBe(0)
    expect((await line(ws, 'test -e /data/copy/locked/y'))[0]).toBe(1)
    const [tarCode, , tarErr] = await line(ws, 'tar -cf /data/a.tar /data/t')
    expect(tarCode).toBe(2)
    expect(tarErr).toBe(
      "tar: Removing leading `/' from member names\n" +
        'tar: /data/t/sealed: Cannot open: Permission denied\n' +
        'tar: /data/t/locked/y: Cannot open: Permission denied\n' +
        'tar: Exiting with failure status due to previous errors\n' +
        'policy denied: frozen\n',
    )
    const [, listOut] = await line(ws, 'tar -tf /data/a.tar')
    expect(listOut).toContain('data/t/sealed/\n')
    expect(listOut).not.toContain('locked/y')
    expect(listOut).toContain('data/t/private/k\n')
    expect(listOut).not.toContain('ghost')
    const [treeCode, treeOut, treeErr] = await line(ws, 'tree /data/t')
    expect(treeCode).toBe(2)
    expect(treeErr).toBe('policy denied: sealed\n')
    expect(treeOut).toContain('`-- sealed  [error opening dir]\n')
  })

  it('an asked scope reached by a walk is refused until named', async () => {
    const ws = await walkWs()
    expect(await line(ws, 'grep -r a /data/t/asked')).toEqual([
      2,
      '',
      'grep: /data/t/asked/a: Permission denied\npolicy denied: nod\n',
    ])
    expect(ws.decisions.pending()).toEqual([])
    const [code, , err] = await line(ws, 'grep a /data/t/asked/a')
    expect(code).toBe(126)
    expect(err).toContain('grep: Permission denied\nrequires approval: nod')
    const [request] = ws.decisions.pending()
    if (request === undefined) throw new Error('no pending request')
    await ws.decisions.answer(request.id, Outcome.ALLOW)
    expect(await line(ws, 'grep a /data/t/asked/a')).toEqual([0, 'a\n', ''])
    // A standing grant covers the walk too.
    await line(ws, 'grep a /data/t/asked/a')
    const [second] = ws.decisions.pending()
    if (second === undefined) throw new Error('no pending request')
    await ws.decisions.answer(second.id, Outcome.ALLOW, Scope.SESSION)
    expect(await line(ws, 'grep -r a /data/t/asked')).toEqual([0, '/data/t/asked/a:a\n', ''])
  })

  it('the op door stats a refused entry and withholds its content', async () => {
    const ws = await walkWs()
    const sess = ws.getSession('g')
    await runWithSession(sess, async () => {
      const st = (await ws.dispatch('stat', '/data/t/locked/y')) as { size?: number }
      expect(st.size).toBe(2)
      await expect(ws.dispatch('read', '/data/t/locked/y')).rejects.toMatchObject({
        code: 'EACCES',
      })
      await expect(ws.dispatch('stat', '/data/t/ghost/g')).rejects.toThrow()
    })
  })
})

describe('a relayed walk meets the command rules', () => {
  const RELAY_DOC: SessionProfile = parseSessionProfile({
    paths: { hide: ['/data/r/ghost'] },
    commands: {
      deny: [
        {
          reason: 'cut',
          commands: {
            split: ['/data/out/xab'],
            csplit: ['/data/out/xx01'],
            awk: ['/data/out/locked'],
            mktemp: ['/data/tmpd/*'],
            unzip: ['/data/uz/*'],
          },
        },
        { reason: 'tarred', commands: { tar: ['/data/r/sec', '/data/r/ghost'] } },
        { reason: 'copied', commands: { cp: ['/data/r/sec', '/data/dst/sec', '/data/r/ghost'] } },
      ],
    },
  })
  const TAR_SEC_REFUSED =
    "tar: Removing leading `/' from member names\n" +
    'tar: /data/r/sec: Cannot open: Permission denied\n' +
    'tar: Exiting with failure status due to previous errors\n' +
    'policy denied: tarred\n'

  async function relayWs(): Promise<Workspace> {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/other': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser, profiles: { relayed: RELAY_DOC } },
    )
    open.push(ws)
    ws.createSession('g', { profile: 'relayed' })
    await ws.shell(
      'mkdir -p /data/r /other/src && echo s > /data/r/sec && ' +
        'echo o > /data/r/open && echo g > /data/r/ghost && ' +
        'echo s > /other/src/sec && echo o > /other/src/open',
    )
    return ws
  }

  async function line(ws: Workspace, text: string): Promise<[number, string, string]> {
    const r = await ws.shell(text, { sessionId: 'g' })
    return [r.exitCode, stdoutStr(r), voicedStderr(r)]
  }

  // A line that spans mounts runs through the cross-mount relay, whose
  // reads and writes reach the op dispatcher rather than the command's own
  // guarded slots. The command rules hold there too, in the voice the
  // single-mount walk uses.
  it('refuses the entries a rule names, reading and writing', async () => {
    const ws = await relayWs()
    expect(await line(ws, 'tar -cf - /data/r | tar -tf -')).toEqual([
      0,
      'data/r/\ndata/r/open\n',
      TAR_SEC_REFUSED,
    ])
    expect(await line(ws, 'tar -cf /other/y.tar /data/r')).toEqual([2, '', TAR_SEC_REFUSED])
    expect((await line(ws, 'tar -tf /other/y.tar'))[1]).toBe('data/r/\ndata/r/open\n')
    expect(await line(ws, 'cp -r /data/r /other/r')).toEqual([
      1,
      '',
      "cp: cannot open '/data/r/sec' for reading: Permission denied\npolicy denied: copied\n",
    ])
    expect((await line(ws, 'find /other/r'))[1]).toBe('/other/r\n/other/r/open\n')
    expect(await line(ws, 'cp -r /other/src /data/dst')).toEqual([
      1,
      '',
      "cp: cannot create regular file '/data/dst/sec': Permission denied\npolicy denied: copied\n",
    ])
    expect((await line(ws, 'find /data/dst'))[1]).toBe('/data/dst\n/data/dst/open\n')
  })

  // split writes each piece through the dispatcher it is handed, not a
  // guarded slot, so a rule on one piece holds there as GNU reports an
  // output it cannot open: the pieces before it stay, the run fails.
  it('holds a write through the command dispatcher to the rules', async () => {
    const ws = await relayWs()
    await ws.shell(
      'mkdir -p /data/out && echo a > /data/f && echo b >> /data/f && echo c >> /data/f',
    )
    expect(await line(ws, 'split -l 1 /data/f /data/out/x')).toEqual([
      1,
      '',
      'split: /data/out/xab: Permission denied\npolicy denied: cut\n',
    ])
    expect(await line(ws, 'csplit -f /data/out/xx /data/f 2')).toEqual([
      1,
      '2\n',
      'csplit: /data/out/xx01: Permission denied\npolicy denied: cut\n',
    ])
    expect(await line(ws, `awk '{print > "/data/out/locked"}' /data/f`)).toEqual([
      2,
      '',
      'awk: cannot open "/data/out/locked" for output (Permission denied)\npolicy denied: cut\n',
    ])
    const listed = (await line(ws, 'ls /data/out'))[1].split('\n')
    expect(listed).toContain('xaa')
    expect(listed).not.toContain('xab')
    expect(listed).not.toContain('xx01')
  })

  // mktemp and unzip create their files and directories through the
  // dispatcher they are handed; a rule on the directory's contents refuses
  // each create in the command's own voice, and nothing lands.
  it('holds a create through the command dispatcher to the rules', async () => {
    const ws = await relayWs()
    await ws.shell(
      'mkdir -p /data/tmpd /data/uz && cd /other && zip -r /other/z.zip src > /dev/null',
    )
    expect(await line(ws, 'mktemp -d -p /data/tmpd')).toEqual([
      1,
      '',
      "mktemp: failed to create directory via template '/data/tmpd/tmp.XXXXXXXXXX': Permission denied\npolicy denied: cut\n",
    ])
    expect(await line(ws, 'mktemp -p /data/tmpd')).toEqual([
      1,
      '',
      "mktemp: failed to create file via template '/data/tmpd/tmp.XXXXXXXXXX': Permission denied\npolicy denied: cut\n",
    ])
    const refused =
      ['', 'open', 'sec']
        .map(
          (name) =>
            'checkdir error:  cannot create /data/uz/src\n' +
            '                 Permission denied\n' +
            `                 unable to process src/${name}.\n`,
        )
        .join('') + 'policy denied: cut\n'
    expect(await line(ws, 'unzip -q -d /data/uz /other/z.zip')).toEqual([2, '', refused])
    expect((await line(ws, 'find /data/tmpd /data/uz'))[1]).toBe('/data/tmpd\n/data/uz\n')
  })
})

describe('a warm walk is refused as the cold walk is', () => {
  const WARM_DOC: SessionProfile = parseSessionProfile({
    paths: { hide: ['/data/w/h.txt'] },
    commands: {
      deny: [
        {
          reason: 'sealed',
          commands: Object.fromEntries(
            ['grep', 'rg', 'cat', 'cp', 'tar'].map((name) => [name, ['/data/w/a.txt']]),
          ),
        },
        { reason: 'walled', paths: ['/data/w/p.txt'] },
      ],
    },
  })
  const WARM_LINES = [
    'grep -r secret /data/w',
    'rg secret /data/w',
    'cat /data/w/*',
    'cp -r /data/w /data/c; echo $?; find /data/c',
    'tar -cf /data/x.tar /data/w; echo $?; tar -tf /data/x.tar',
    'tar -cf - /data/w | tar -tf -',
  ]

  // A caching mount, seeded and optionally read whole by the unrestricted
  // default session, whose reads fill the shared cache.
  async function warmWs(warm: boolean): Promise<[Workspace, RAMVFS]> {
    const parser = await getTestParser()
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, shellParser: parser, profiles: { limited: WARM_DOC } },
    )
    open.push(ws)
    ws.createSession('g', { profile: 'limited' })
    await ws.shell(
      "mkdir -p /data/w && echo 'secret a' > /data/w/a.txt && " +
        "echo 'secret p' > /data/w/p.txt && echo 'secret h' > /data/w/h.txt && " +
        "echo 'secret open' > /data/w/b.txt",
    )
    if (warm) {
      await ws.shell('cat /data/w/a.txt /data/w/p.txt /data/w/h.txt /data/w/b.txt > /dev/null')
    }
    return [ws, ram]
  }

  async function line(ws: Workspace, text: string): Promise<[number, string, string]> {
    const r = await ws.shell(text, { sessionId: 'g' })
    return [r.exitCode, stdoutStr(r), voicedStderr(r)]
  }

  // The cache is shared by every session, so bytes another session read
  // must not reach a walk the running command's rules refuse: every walk
  // answers warm exactly as it answers cold.
  it('answers every walk warm as it answers it cold', async () => {
    const differs: string[] = []
    for (const text of WARM_LINES) {
      const [cold] = await warmWs(false)
      const [warm] = await warmWs(true)
      if (JSON.stringify(await line(warm, text)) !== JSON.stringify(await line(cold, text))) {
        differs.push(text)
      }
    }
    expect(differs).toEqual([])
    const [ws] = await warmWs(true)
    expect(await line(ws, 'grep -r secret /data/w')).toEqual([
      2,
      '/data/w/b.txt:secret open\n',
      'grep: /data/w/a.txt: Permission denied\ngrep: /data/w/p.txt: Permission denied\npolicy denied: walled\n',
    ])
  })

  // The backend changes behind the cache's back: the walk still sees the
  // bytes the cache holds, so only refused entries go cold.
  it('still serves a warm entry no rule refuses from the cache', async () => {
    const [ws, ram] = await warmWs(true)
    await ops(ram).write(
      PathSpec.fromStrPath('/w/b.txt'),
      new TextEncoder().encode('secret changed\n'),
    )
    const [, out] = await line(ws, 'grep -r secret /data/w')
    expect(out).toContain('/data/w/b.txt:secret open\n')
    expect(out).not.toContain('changed')
  })
})

describe('a dispatched read through a link meets the target rule', () => {
  const LINKED_DOC: SessionProfile = parseSessionProfile({
    commands: {
      deny: [{ reason: 'sealed', commands: { awk: ['/data/secret'], sed: ['/data/secret'] } }],
    },
  })

  // A path a command names inside its own program (awk's getline, sed's r)
  // reaches the dispatcher unjudged, and the door follows a link to its
  // target. The rule on the target holds through the link exactly as it
  // holds on the target itself; a link to an allowed file reads.
  it('refuses the target as it refuses the target named', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser, profiles: { linked: LINKED_DOC } },
    )
    open.push(ws)
    ws.createSession('g', { profile: 'linked' })
    await ws.shell(
      'echo TOPSECRET > /data/secret && echo ok > /data/f && ' +
        'ln -s /data/secret /data/alias && ln -s /data/f /data/okalias',
    )
    const line = async (text: string): Promise<[number, string, string]> => {
      const r = await ws.shell(text, { sessionId: 'g' })
      return [r.exitCode, stdoutStr(r), voicedStderr(r)]
    }
    for (const name of ['secret', 'alias']) {
      expect(await line(`awk 'BEGIN { getline x < "/data/${name}"; print x }'`)).toEqual([
        0,
        '\n',
        'policy denied: sealed\n',
      ])
      expect(await line(`sed -n 'r /data/${name}' /data/f`)).toEqual([
        0,
        '',
        'policy denied: sealed\n',
      ])
    }
    expect(await line(`awk 'BEGIN { getline x < "/data/okalias"; print x }'`)).toEqual([
      0,
      'ok\n',
      '',
    ])
    expect(await line(`sed -n 'r /data/okalias' /data/f`)).toEqual([0, 'ok\n', ''])
  })
})

describe('a dispatched op meets the rule on the path the door reaches', () => {
  // A host command that removes or moves a name through the dispatcher it
  // is handed, the way a custom command reaches a mount.
  const zap = new RegisteredCommand({
    name: 'zap',
    spec: CMD_SPEC,
    vfs: VFSName.RAM,
    fn: async (_accessor, _paths, texts, opts) => {
      const target = PathSpec.fromStrPath('/data/alias/secret')
      const dispatch = opts.dispatch
      if (dispatch === undefined) throw new Error('no dispatcher')
      try {
        if (texts[0] === 'rename') {
          await dispatch('rename', target, [PathSpec.fromStrPath('/data/moved')])
        } else {
          await dispatch('unlink', target)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(`zap: ${message}\n`) }),
        ]
      }
      return [new TextEncoder().encode('done\n'), new IOResult()]
    },
  })

  async function line(ws: Workspace, text: string): Promise<[number, string, string]> {
    const r = await ws.shell(text, { sessionId: 'g' })
    return [r.exitCode, stdoutStr(r), voicedStderr(r)]
  }

  // The door walks every link above the final name before it acts, so
  // /data/alias/secret is /data/real/secret by the time anything is removed
  // or moved. The rule on the real path holds there for an op on the name
  // itself (unlink, rename) as for one that follows it.
  it('holds the rule through a linked parent', async () => {
    const doc = parseSessionProfile({
      commands: {
        deny: [{ reason: 'sealed', commands: { zap: ['/data/real/secret'] } }],
      },
    })
    for (const op of ['unlink', 'rename']) {
      const parser = await getTestParser()
      const ws = new Workspace(
        { '/data': new RAMVFS() },
        { mode: MountMode.WRITE, shellParser: parser, profiles: { zapped: doc } },
      )
      open.push(ws)
      ws.registry.mountForPrefix('/data').register(zap)
      ws.createSession('g', { profile: 'zapped' })
      await ws.shell(
        'mkdir -p /data/real && echo s > /data/real/secret && ln -s /data/real /data/alias',
      )
      const [code, out, err] = await line(ws, `zap ${op}`)
      expect([code, out]).toEqual([1, ''])
      expect(err).toContain('sealed')
      expect((await line(ws, 'ls /data/real'))[1]).toBe('secret\n')
    }
  })

  // The door judges the path the command handed it as well as the one its
  // walk reaches, so a rule written through a link holds for the command's
  // own ops exactly as it holds for a named operand.
  it('binds a rule spelled through a linked parent', async () => {
    const doc = parseSessionProfile({
      commands: {
        deny: [
          {
            reason: 'sealed',
            commands: { sed: ['/data/dalias/secret'], cat: ['/data/dalias/secret'] },
          },
        ],
      },
    })
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser, profiles: { spelled: doc } },
    )
    open.push(ws)
    ws.createSession('g', { profile: 'spelled' })
    await ws.shell(
      'mkdir -p /data/real && echo s > /data/real/secret && ln -s /data/real /data/dalias && echo o > /data/f',
    )
    expect(await line(ws, "sed -n 'w /data/dalias/secret' /data/f")).toEqual([
      4,
      '',
      "sed: couldn't open file /data/dalias/secret: Permission denied\npolicy denied: sealed\n",
    ])
    expect(await line(ws, 'cat /data/dalias/secret')).toEqual([
      1,
      '',
      'cat: /data/dalias/secret: Permission denied\npolicy denied: sealed\n',
    ])
    expect(stdoutStr(await ws.shell('cat /data/real/secret'))).toBe('s\n')
  })
})

describe('a walk the executor fans out meets the command rules', () => {
  const FANOUT_DOC: SessionProfile = parseSessionProfile({
    commands: {
      deny: [
        {
          reason: 'sealed',
          commands: { rg: ['/data/w/a.txt'], find: ['/data/w/a.txt'], tree: ['/data/sub/x'] },
        },
      ],
    },
  })

  // A mount nested inside the walked one sends rg's ordered walk and
  // find's actions through the executor's own dispatcher.
  async function fanoutWs(): Promise<Workspace> {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/data/sub': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser, profiles: { limited: FANOUT_DOC } },
    )
    open.push(ws)
    ws.createSession('g', { profile: 'limited' })
    await ws.shell(
      "mkdir -p /data/w && echo 'secret a' > /data/w/a.txt && echo 'secret b' > /data/w/b.txt",
    )
    return ws
  }

  async function line(ws: Workspace, text: string): Promise<[number, string, string]> {
    const r = await ws.shell(text, { sessionId: 'g' })
    return [r.exitCode, stdoutStr(r), voicedStderr(r)]
  }

  // --sort walks every mount through the dispatcher in one ordered pass;
  // the entry the rule names is refused as the plain walk does.
  it('refuses an ordered rg across mounts as the plain walk does', async () => {
    const ws = await fanoutWs()
    const expected = [
      2,
      '/data/w/b.txt:secret b\n',
      'rg: /data/w/a.txt: Permission denied (os error 13)\npolicy denied: sealed\n',
    ]
    expect(await line(ws, 'rg secret /data')).toEqual(expected)
    expect(await line(ws, 'rg --sort path secret /data')).toEqual(expected)
  })

  // tree lists a nested mount through the dispatcher; a directory the rule
  // names is marked inline as on a single mount, never listed.
  it('marks a directory across mounts tree may not open', async () => {
    const ws = await fanoutWs()
    await ws.shell('mkdir -p /data/sub/x && echo s > /data/sub/x/k')
    expect(await line(ws, 'tree /data')).toEqual([
      2,
      '/data\n|-- sub\n|   `-- x  [error opening dir]\n`-- w\n' +
        '    |-- a.txt\n    `-- b.txt\n\n4 directories, 2 files\n',
      'policy denied: sealed\n',
    ])
  })

  // The deletion is find's own write: an entry the rule names stays,
  // reported with the rule's reason, as a paths rule's refusal at the op
  // door already is.
  it('keeps an entry find -delete may not remove', async () => {
    const ws = await fanoutWs()
    expect(await line(ws, 'find /data/w -name a.txt -delete')).toEqual([
      1,
      '',
      "find: cannot delete '/data/w/a.txt': Permission denied\npolicy denied: sealed\n",
    ])
    expect((await line(ws, 'ls /data/w'))[1]).toBe('a.txt\nb.txt\n')
  })
})

describe('a dispatched op is judged by the gate of the command that issued it', () => {
  const SEALED_DOC = parseSessionProfile({
    commands: {
      deny: [{ reason: 'sealed', commands: { sed: ['/data/real/secret'] } }],
    },
  })
  const OPEN_DOC = parseSessionProfile({})

  async function sealedWs(): Promise<Workspace> {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: { sealed: SEALED_DOC, open: OPEN_DOC },
      },
    )
    open.push(ws)
    ws.createSession('g', { profile: 'sealed' })
    ws.createSession('h', { profile: 'open' })
    await ws.shell('mkdir -p /data/real && echo s > /data/real/secret && echo o > /data/f')
    return ws
  }

  async function line(
    ws: Workspace,
    text: string,
    sessionId: string,
  ): Promise<[number, string, string]> {
    const r = await ws.shell(text, { sessionId })
    return [r.exitCode, stdoutStr(r), voicedStderr(r)]
  }

  // find -exec runs sed as a line of its own: sed's write is judged by sed's
  // rules, and the outer find (no rule) lends it nothing.
  it('judges a nested line by its own command', async () => {
    const ws = await sealedWs()
    const [, , err] = await line(ws, "find /data/f -exec sed -n 'w /data/real/secret' {} \\;", 'g')
    expect(err).toContain("sed: couldn't open file /data/real/secret: Permission denied")
    expect(stdoutStr(await ws.shell('cat /data/real/secret'))).toBe('s\n')
  })

  // Two sessions write at once: each op carries its own command's gate, so
  // the sealed session is refused and the open one is not.
  it('keeps concurrent sessions to their own gates', async () => {
    const ws = await sealedWs()
    const [sealed, opened] = await Promise.all([
      line(ws, "sed -n 'w /data/real/secret' /data/f", 'g'),
      line(ws, "sed -n 'w /data/real/other' /data/f", 'h'),
    ])
    expect(sealed).toEqual([
      4,
      '',
      "sed: couldn't open file /data/real/secret: Permission denied\npolicy denied: sealed\n",
    ])
    expect(opened).toEqual([0, '', ''])
    expect(stdoutStr(await ws.shell('cat /data/real/other'))).toBe('o\n')
  })

  // The command rules bind what a command does; the session's raw door
  // (ws.vfs, the agent's file tool) is held to paths rules only, as before.
  it('leaves the raw vfs route to its own policy scope', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          mixed: parseSessionProfile({
            commands: {
              deny: [
                { reason: 'sealed', commands: { cat: ['/data/real/secret'] } },
                { reason: 'walled', paths: ['/data/real/walled'] },
              ],
            },
          }),
        },
      },
    )
    open.push(ws)
    await ws.shell(
      'mkdir -p /data/real && echo s > /data/real/secret && echo w > /data/real/walled',
    )
    const handle = await ws.session('g', { profile: 'mixed' })
    expect(await handle.vfs.cat('/data/real/secret')).toBe('s\n')
    await expect(handle.vfs.read('/data/real/walled')).rejects.toThrow()
    expect((await handle.shell('cat /data/real/secret')).exitCode).toBe(1)
  })
})

describe('admitted path rules on recursive commands', () => {
  it.each([
    ['find /data/src', 1],
    ['du -a /data/src', 1],
    ['du -s /data/src', 1],
    ['grep -r PRIVATE_SENTINEL /data/src', 2],
    ['rg PRIVATE_SENTINEL /data/src', 2],
  ])('recursive commands enforce admitted path rules: %s', async (command, exitCode) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    open.push(ws)
    await ws.shell('mkdir -p /data/src/cache')
    await ws.vfs.write('/data/src/cache/private.txt', ENC.encode('PRIVATE_SENTINEL\n'))
    await ws.vfs.write('/data/src/public.txt', ENC.encode('public\n'))
    ws.createSession('restricted', {
      profile: { commands: { deny: [{ paths: ['/data/src/cache'], reason: 'sealed' }] } },
    })

    const result = await ws.shell(command, { sessionId: 'restricted' })

    expect(result.exitCode).toBe(exitCode)
    expect(stdoutStr(result)).not.toContain('private.txt')
    expect(stdoutStr(result)).not.toContain('PRIVATE_SENTINEL')
    expect(voicedStderr(result)).toContain('/data/src/cache')
    expect(voicedStderr(result)).toContain('Permission denied')
  })
})

describe('coded preOps on native walks', () => {
  // Refuses listing /data/sec, as a mode 0300 directory does.
  const sealedSubtree: Policy = {
    preOps: (ctx: OpsContext) =>
      ctx.op === 'readdir' && ctx.path.virtual.startsWith('/data/sec')
        ? { kind: 'deny', reason: 'sealed' }
        : null,
  }

  it.each([
    ['find /data', "find: '/data/sec': Permission denied\n"],
    ['find /data/sec', "find: '/data/sec': Permission denied\n"],
    ['du -a /data', "du: cannot read directory '/data/sec': Permission denied\n"],
    ['du -a /data/sec', "du: cannot read directory '/data/sec': Permission denied\n"],
  ])('%s walks through the deny', async (command, refusal) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    open.push(ws)
    await ws.shell('mkdir -p /data/sec && echo SECRET > /data/sec/k.txt')
    ws.policies.add(sealedSubtree)
    const result = await ws.shell(command)
    expect(result.exitCode).toBe(1)
    expect(stdoutStr(result)).not.toContain('/data/sec/k.txt')
    expect(stderrStr(result)).toBe(refusal)
  })
})
