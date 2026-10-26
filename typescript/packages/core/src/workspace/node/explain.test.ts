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
import { z } from 'zod'

import { runExplaining, runWithRefusalSink } from '../../context/session_context.ts'
import { Outcome, Scope } from '../../policy/index.ts'
import { DryRun } from '../../policy/types.ts'
import type {
  Action,
  AskHandler,
  CommandContext,
  CommandExplanation,
  Policy,
  ShellNode,
} from '../../policy/index.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Runtime } from '../../runtime/base.ts'
import { LINE_EXECUTOR, type LineExecutor } from '../../runtime/mixin.ts'
import type { RunResult } from '../../runtime/types.ts'
import type { Context } from '../../commands/config.ts'
import type { JobConsole } from '../../shell/console/index.ts'
import { registerSecrets } from '../../secrets/registry.ts'
import { MountMode, type PathSpec } from '../../types.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { Session, Workspace } from '../workspace/workspace.ts'
import { explainLine, type Judgment } from './explain.ts'
import { parse } from '../../shell/parse/parse.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

const ALLOW = [
  'ls',
  'cat',
  'git',
  'rm',
  'mkdir',
  'cd',
  'echo',
  'sleep',
  'wait',
  'eval',
  'command',
  'xargs',
  'touch',
  'printf',
  'mapfile',
  'alias',
  'shopt',
]

const PROFILE = parseSessionProfile({
  commands: {
    allow: ALLOW,
    deny: [{ reason: 'production data is protected', commands: { rm: ['/data/prod/*'] } }],
    ask: [
      { reason: 'pushes need sign-off', commands: ['git push'] },
      {
        reason: 'secrets need sign-off',
        commands: { cat: ['/data/secret.txt', '/data/secret file', '/data/secrét'] },
      },
    ],
  },
})

// The same world under a rule that speaks on the command name alone, so
// a spelling whose operands only the runtime can read is still asked
// about.
const ASK_CAT = parseSessionProfile({
  commands: { allow: ALLOW, ask: [{ reason: 'reads need sign-off', commands: ['cat'] }] },
})

const DENY_CAT = parseSessionProfile({
  commands: { allow: ALLOW, deny: [{ reason: 'reads are refused', commands: ['cat'] }] },
})

const open: Workspace[] = []
afterEach(async () => {
  for (const w of open.splice(0)) await w.close()
})

async function ws(): Promise<Workspace> {
  const w = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, profiles: { r: PROFILE } },
  )
  open.push(w)
  await w.shell('mkdir -p /data/prod')
  await w.shell('echo x > /data/prod/x.txt')
  await w.shell('echo a > /data/a.txt')
  await w.shell('echo s > /data/secret.txt')
  w.createSession('s', { profile: 'r' })
  return w
}

/**
 * A line's per-command judgments, read as `Workspace.explain` reads
 * them; `wholeLine` when a runtime takes the line whole.
 */
async function judged(
  w: Workspace,
  line: string,
  sessionId = '',
  wholeLine = false,
): Promise<Judgment[]> {
  await w.ensureSessionsLoaded()
  const session = w.getSession(sessionId === '' ? w.defaultSessionId : sessionId)
  const said = await runWithRefusalSink(
    () => undefined,
    () =>
      runExplaining(DryRun.DECIDING, () =>
        explainLine(
          parse(line),
          session,
          w.registry,
          w.namespace,
          (text) => parse(text),
          wholeLine,
        ),
      ),
  )
  return said.map((one) => one.judgment)
}

/**
 * The same world as `ws`, with a host that answers an ask inline, under
 * `profile` for session `s`.
 */
async function inlineWs(onAsk: AskHandler, profile = PROFILE): Promise<Workspace> {
  const w = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, profiles: { r: profile }, onAsk },
  )
  open.push(w)
  await w.shell('mkdir -p /data/prod')
  await w.shell('echo x > /data/prod/x.txt')
  await w.shell('echo a > /data/a.txt')
  await w.shell('echo s > /data/secret.txt')
  w.createSession('s', { profile: 'r' })
  return w
}

/**
 * The inline world with `c` an alias for the guarded read and `d` an
 * alias for `c`, defined on a line of their own so the lines after it
 * expand them.
 */
async function aliased(asked: string[]): Promise<Workspace> {
  const w = await inlineWs(answering(asked, Outcome.ALLOW))
  const defined = await w.shell("shopt -s expand_aliases; alias c='cat /data/secret.txt' d=c", {
    sessionId: 's',
  })
  expect(defined.exitCode).toBe(0)
  return w
}

class LineBox extends Runtime implements LineExecutor {
  override readonly reach = 'workspace' as const
  readonly [LINE_EXECUTOR] = true as const
  readonly name = 'sandbox'
  declare captures: readonly string[]
  lines: string[] = []

  constructor() {
    super({ captures: ['*'] })
  }

  runLine(_e: unknown, _p: PathSpec[], _t: string[], ctx: Context): Promise<RunResult> {
    const line = ctx.flags.c as string
    this.lines.push(line)
    return Promise.resolve({ stdout: ENC.encode(`box:${line}`), stderr: null, exitCode: 0 })
  }
}

/** Every command an explained tree holds, nested scopes included. */
function commands(node: ShellNode): CommandExplanation[] {
  return node.children.flatMap((child) =>
    'command' in child ? [child, ...child.children.flatMap(commands)] : commands(child),
  )
}

/** A host answering every question the same way, counting what it was asked. */
function answering(asked: string[], outcome: Outcome, scope = Scope.ONCE): AskHandler {
  return (record) => {
    asked.push(record.id)
    return Promise.resolve({ ...record, outcome, scope })
  }
}

describe('explain', () => {
  it('answers each verb and names the rule', async () => {
    const w = await ws()
    const [allowed] = await judged(w, 'cat /data/a.txt', 's')
    expect(allowed?.outcome).toBe(Outcome.ALLOW)
    expect(allowed?.exitCode).toBe(0)
    expect(allowed?.rule).toBeNull()

    const [denied] = await judged(w, 'rm /data/prod/x.txt', 's')
    expect(denied?.outcome).toBe(Outcome.DENY)
    expect(denied?.reason).toBe('production data is protected')
    expect(denied?.source).toBe('top')
    expect(denied?.matchedPath).toBe('/data/prod/x.txt')

    const [asked] = await judged(w, 'git push origin main', 's')
    expect(asked?.outcome).toBe(Outcome.ASK)
    expect(asked?.reason).toBe('pushes need sign-off')
  })

  it('reports a word the allow list leaves out as a deny at 126', async () => {
    // The allow list is the profile's policy: a word it leaves out is a
    // DENY with no rule, refused in bash's words like any other.
    const w = await ws()
    const [missing] = await judged(w, 'gerp x', 's')
    expect(missing?.outcome).toBe(Outcome.DENY)
    expect(missing?.rule).toBeNull()
    expect(missing?.source).toBe('commands.allow')
    expect(missing?.exitCode).toBe(126)
    expect(missing?.stderr).toBe('gerp: Permission denied\n')
  })

  it.each(['timeout 5 sort /data/a.txt', 'eval sort /data/a.txt'])(
    'refuses a word the allow list leaves out where it runs: %s',
    async (line) => {
      // A builtin that runs a word hands it to the gate, which refuses it
      // there, and the dry run says what the run says.
      const profile = parseSessionProfile({ commands: { allow: ['timeout', 'eval'] } })
      const w = new Workspace(
        { '/data': new RAMVFS() },
        { mode: MountMode.WRITE, profiles: { r: profile } },
      )
      open.push(w)
      await w.vfs.write('/data/a.txt', 'a\n')
      w.createSession('s', { profile: 'r' })
      const ran = await w.shell(line, { sessionId: 's' })
      const missing = (await judged(w, line, 's')).at(-1)
      const said = 'sort: Permission denied\n'
      expect([ran.exitCode, DEC.decode(ran.stderr)]).toEqual([126, said])
      expect([missing?.exitCode, missing?.stderr]).toEqual([126, said])
      expect([missing?.command, missing?.source]).toEqual(['sort', 'commands.allow'])
    },
  )

  it('reads every command of a line', async () => {
    const w = await ws()
    const [first, second] = await judged(w, 'cat /data/a.txt && rm /data/prod/x.txt', 's')
    expect([first?.command, first?.outcome]).toEqual(['cat', Outcome.ALLOW])
    expect([second?.command, second?.outcome]).toEqual(['rm', Outcome.DENY])
  })

  it('reads a reserved word alias as a command', async () => {
    const w = await ws()
    await w.shell("shopt -s expand_aliases; alias fi='echo works'", { sessionId: 's' })
    const said = await w.explain('fi', 's')
    expect(said.node.children.map((child) => ('command' in child ? child.command : null))).toEqual([
      'fi',
    ])
  })

  it('says exactly what the run would say', async () => {
    const w = await ws()
    for (const line of ['rm /data/prod/x.txt', 'git push origin main', 'gerp x']) {
      const ran = await w.shell(line, { sessionId: 's' })
      const [said] = await judged(w, line, 's')
      expect(said?.exitCode).toBe(ran.exitCode)
      expect(said?.stderr).toBe(DEC.decode(ran.stderr))
    }
  })

  it('refuses the whole line only for a verdict', async () => {
    // A word the allow list leaves out fails where it stands and the rest
    // of the line runs; a rule's refusal holds the whole line, whatever
    // failed before it.
    const w = await ws()
    let said = await w.explain('gerp x; echo ok', 's')
    let ran = await w.shell('gerp x; echo ok', { sessionId: 's' })
    expect([ran.exitCode, said.outcome, said.exitCode]).toEqual([0, Outcome.ALLOW, 0])
    const [gerp] = said.node.children
    expect(
      gerp !== undefined && 'command' in gerp
        ? [gerp.outcome, gerp.exitCode, gerp.stderr, gerp.source]
        : null,
    ).toEqual([Outcome.DENY, 126, 'gerp: Permission denied\n', 'commands.allow'])
    const line = 'gerp x; rm /data/prod/x.txt'
    said = await w.explain(line, 's')
    ran = await w.shell(line, { sessionId: 's' })
    expect([said.exitCode, said.stderr, said.refusal?.reason]).toEqual([
      ran.exitCode,
      DEC.decode(ran.stderr),
      ran.refusal?.reason,
    ])
  })

  it('spends nothing', async () => {
    // A dry run of an ask must not put the question to anyone, or the
    // host would field requests for lines nobody typed, and must not
    // spend a grant, or explaining a line would use up its answer.
    const w = await ws()
    for (let i = 0; i < 3; i += 1) await w.explain('git push origin main', 's')
    expect(w.decisions.pending()).toEqual([])
    expect(w.getSession('s').decisions).toEqual([])
    await w.explain('rm /data/prod/x.txt', 's')
    expect((await w.vfs.readdir('/data')).sort()).toEqual([
      '/data/a.txt',
      '/data/prod',
      '/data/secret.txt',
    ])
  })

  it('stops the whole line when a rule denies one command', async () => {
    // The agent composed the line as one intent, so a rule refusing
    // part of it refuses the intent: judging each command as the
    // dispatcher reached it deleted the first file and refused the
    // second.
    const w = await ws()
    const ran = await w.shell('rm /data/a.txt && rm /data/prod/x.txt', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stderr)).toBe("rm: cannot remove '/data/prod/x.txt': Permission denied\n")
    expect(await w.vfs.readdir('/data')).toContain('/data/a.txt')
  })

  it('leaves a line alone when the allow list leaves a word out', async () => {
    // The allow list refuses a word where it stands, not the line. A typo
    // must not cost an agent the work the line already did.
    const w = await ws()
    const ran = await w.shell('rm /data/a.txt && gerp x', { sessionId: 's' })
    expect(ran.exitCode).toBe(126)
    expect(DEC.decode(ran.stderr)).toBe('gerp: Permission denied\n')
    expect(await w.vfs.readdir('/data')).not.toContain('/data/a.txt')
  })

  it('holds a line with an asked command until it is answered', async () => {
    const w = await ws()
    const line = 'rm /data/a.txt && cat /data/secret.txt'
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(126)
    expect(await w.vfs.readdir('/data')).toContain('/data/a.txt')
    // Exactly one request, from the one pass that judged the line.
    const [pending] = w.decisions.pending()
    expect(w.decisions.pending()).toHaveLength(1)
    await w.decisions.answer(pending?.id ?? '', Outcome.ALLOW, Scope.ONCE)
    // The whole line replays, which is only sound because none of it
    // ran the first time, and the grant is spent exactly once even
    // though two passes now read it.
    const again = await w.shell(line, { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(await w.vfs.readdir('/data')).not.toContain('/data/a.txt')
    expect(w.decisions.pending()).toEqual([])
  })

  it.each([
    ['[[ ! -e /data/secret.txt ]]', '1'],
    ['[[ -e /data/a.txt && -e /data/secret.txt ]]', '0'],
    ['[ ! -e /data/secret.txt ]', '1'],
  ])('runs an asked test once on its one nod: %s', async (test, status) => {
    // Every reader of the line reads a test by the run's own tokens and
    // grammar, a [[ ]] a leaf at a time, so the question the pass asked is
    // the one the gate answers: the line runs once, on one nod.
    const w = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    open.push(w)
    await w.vfs.write('/data/a.txt', 'a\n')
    await w.vfs.write('/data/secret.txt', 's\n')
    w.createSession('s', {
      profile: { commands: { ask: [{ reason: 'nod', paths: ['/data/secret.txt'] }] } },
    })
    const line = `echo before; ${test}; echo rc=$?`
    const held = await w.shell(line, { sessionId: 's' })
    expect([held.exitCode, DEC.decode(held.stdout)]).toEqual([126, ''])
    const [pending] = w.decisions.pending()
    expect(w.decisions.pending()).toHaveLength(1)
    await w.decisions.answer(pending?.id ?? '', Outcome.ALLOW, Scope.ONCE)
    const ran = await w.shell(line, { sessionId: 's' })
    expect(DEC.decode(ran.stdout)).toBe(`before\nrc=${status}\n`)
    expect(w.decisions.pending()).toEqual([])
  })

  it('holds no line on a question the gate asks where it runs', async () => {
    // find -exec hands cat words the runtime completes, so the run leaves
    // cat's question to the gate where it runs and holds nothing; explain
    // says the same rather than a hold the run never makes.
    const w = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    open.push(w)
    await w.shell('echo a > /data/a.txt; echo s > /data/secret.txt')
    w.createSession('s', {
      profile: { commands: { ask: [{ reason: 'nod', paths: ['/data/secret.txt'] }] } },
    })
    const line = 'find /data -name a.txt -exec cat /data/secret.txt \\;'
    const said = await w.explain(line, 's')
    const ran = await w.shell(line, { sessionId: 's' })
    expect([said.exitCode, said.outcome]).toEqual([0, Outcome.ALLOW])
    expect([ran.exitCode, DEC.decode(ran.stderr)]).toEqual([0, 'cat: Permission denied\n'])
    expect(w.decisions.pending()).toHaveLength(1)
  })

  it('moves what later rules read when the line begins with a cd', async () => {
    // The line is judged before it runs, so the pass has to walk a
    // literal `cd` itself or a rule about /data/prod would answer about
    // whatever directory the session happened to be in.
    const w = await ws()
    const ran = await w.shell('cd /data/prod && rm x.txt', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stderr)).toBe("rm: cannot remove 'x.txt': Permission denied\n")
  })

  it('reads a cd the same way the run does', async () => {
    // explain and the pass that decides the line share one walk, so a
    // host asking about a line and the agent typing it cannot be told
    // different things about where the line ends up.
    const w = await ws()
    const line = 'cd /data/prod && rm x.txt'
    const [, removed] = await judged(w, line, 's')
    expect(removed?.outcome).toBe(Outcome.DENY)
    const ran = await w.shell(line, { sessionId: 's' })
    expect(removed?.exitCode).toBe(ran.exitCode)
    expect(removed?.stderr).toBe(DEC.decode(ran.stderr))
  })

  it('holds a line only as far as the text reaches', async () => {
    // The pass reads the text of a line and the gate reads its values,
    // so a path the runtime computes is invisible here and the hold
    // lapses. The ask still fires, at the gate, once the earlier
    // commands have run. Pinned rather than only documented, because
    // the cost lands on the replay: approving this re-runs a line whose
    // first half is already done.
    const w = await ws()
    const ran = await w.shell('S=/data/secret.txt; rm /data/a.txt && cat $S', {
      sessionId: 's',
    })
    expect(ran.exitCode).toBe(126)
    expect(await w.vfs.readdir('/data')).not.toContain('/data/a.txt')
    expect(w.decisions.pending()).toHaveLength(1)
  })

  it('does not move later commands for a cd inside a subshell', async () => {
    // bash restores the cwd when the subshell exits, so carrying the cd
    // past it refused a line that was never going to touch /data/prod.
    const w = await ws()
    const ran = await w.shell('(cd /data/prod && ls) && rm x.txt', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stderr)).not.toContain('production data is protected')
    expect(await w.vfs.readdir('/data/prod')).toContain('/data/prod/x.txt')
  })

  it('shows a line running once the session holds a grant', async () => {
    const w = await ws()
    const ran = await w.shell('git push origin main', { sessionId: 's' })
    expect(ran.exitCode).toBe(126)
    const [pending] = w.decisions.pending()
    await w.decisions.answer(pending?.id ?? '', Outcome.ALLOW, Scope.SESSION)
    // The document still says ask, because that is what it says; the
    // exit code says 0, because that is what the line would now do.
    const [asked] = await judged(w, 'git push origin main', 's')
    expect(asked?.outcome).toBe(Outcome.ASK)
    expect(asked?.exitCode).toBe(0)
    expect(asked?.stderr).toBe('')
    const said = await w.explain('git push origin main', 's')
    expect([said.outcome, said.reason, said.exitCode, said.refusal]).toEqual([
      Outcome.ASK,
      'pushes need sign-off',
      0,
      null,
    ])
  })
})

const SEALED = parseSessionProfile({
  commands: {
    allow: ['ls', 'cat', 'rm', 'mkdir', 'echo'],
    deny: [{ reason: 'sealed until review', paths: ['/data/prod/*'] }],
  },
})

async function sealedWs(): Promise<Workspace> {
  const w = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, profiles: { r: SEALED } },
  )
  open.push(w)
  await w.shell('mkdir -p /data/prod')
  await w.shell('echo x > /data/prod/x.txt')
  await w.shell('echo a > /data/a.txt')
  w.createSession('s', { profile: 'r' })
  return w
}

class SealedSecret implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    if (!ctx.paths.some((p) => p.virtual === '/data/secret.txt')) return null
    return { kind: 'deny', reason: 'sealed' }
  }
}

class NoCat implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    if (ctx.command !== 'cat') return null
    return { kind: 'deny', reason: 'cat is refused by policy' }
  }
}

describe('prejudge', () => {
  it('reads the statement’s redirect target', async () => {
    // The shell opens a redirect on its own fd, outside the window the
    // command's own gate covers, so admission reads the target as a word
    // of the command. The dry run has to read it the same way or it
    // answers ALLOW for a line the run refuses.
    const w = await sealedWs()
    const [said] = await judged(w, 'echo x > /data/prod/x.txt', 's')
    expect(said?.outcome).toBe(Outcome.DENY)
    expect(said?.reason).toBe('sealed until review')
  })

  it('holds the whole line for a rule on a redirect target', async () => {
    // `a && b > f` parses as one redirected statement wrapping the list,
    // so the target belongs to the last command of the chain, not the
    // statement's first child.
    const w = await sealedWs()
    const ran = await w.shell('rm /data/a.txt && echo x > /data/prod/x.txt', { sessionId: 's' })
    expect(ran.exitCode).not.toBe(0)
    expect(ran.refusal?.reason).toContain('sealed until review')
    expect(await w.vfs.readdir('/data')).toContain('/data/a.txt')
  })

  it('lets a coded policy answer as the command runs', async () => {
    // The pass that judges a line before it runs asks the profile's
    // rules alone; a policy written in code answers preCommand once, as
    // its command runs, so the commands before it have run. A line it
    // refuses whole is preExecute's.
    const w = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, policies: [new NoCat()] },
    )
    open.push(w)
    await w.shell('echo a > /data/a.txt')
    await w.shell('echo b > /data/b.txt')
    const ran = await w.shell('rm /data/a.txt && cat /data/b.txt')
    expect(ran.exitCode).not.toBe(0)
    expect(DEC.decode(ran.stderr)).toBe('cat: Permission denied\n')
    expect(ran.refusal?.reason).toBe('cat is refused by policy')
    expect(await w.vfs.readdir('/data')).not.toContain('/data/a.txt')
  })

  it('does not end the scan when an ask is answered inline', async () => {
    // The host answers the cat inline, so admit admits it. The rest of
    // the line has not been judged yet: reading that admission as "the
    // line is fine" let the later deny run behind an approval, which is
    // the half-line behavior in its worst form, since the agent was told
    // yes.
    const w = await inlineWs(answering([], Outcome.ALLOW))
    const ran = await w.shell('cat /data/secret.txt && rm /data/prod/x.txt', { sessionId: 's' })
    expect(ran.exitCode).not.toBe(0)
    expect(ran.refusal?.reason).toContain('production data is protected')
    expect(DEC.decode(ran.stdout)).not.toContain('s')
    expect(await w.vfs.readdir('/data/prod')).toContain('/data/prod/x.txt')
  })

  it('asks once for a compound line answered inline, and again for the next', async () => {
    // Two passes read this line: this one, which judges every command
    // before any runs, and the per-command gate, which runs it. The host
    // answers the cat here, and that one nod has to carry the line through
    // the gate, or the human is asked twice for one run. It carries no
    // further: the next identical line is a new question.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const line = 'rm /data/a.txt && cat /data/secret.txt'
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('s\n')
    expect(asked).toHaveLength(1)
    await w.shell('echo a > /data/a.txt', { sessionId: 's' })
    const again = await w.shell(line, { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(asked).toHaveLength(2)
    // Both grants were spent by the lines they were given for.
    expect(w.decisions.list('s')).toEqual([])
  })

  it('refuses the retry of a compound line just refused without asking again', async () => {
    // The human who said no is not asked about the agent's immediate retry:
    // the refusal stands to refuse it from the record, is spent by it, and
    // the run after that is an open question again. The same rule the
    // per-command gate keeps for a one-command line.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.DENY))
    const line = 'rm /data/a.txt && cat /data/secret.txt'
    for (const expected of [1, 1, 2]) {
      const ran = await w.shell(line, { sessionId: 's' })
      expect(ran.exitCode).toBe(126)
      expect(asked).toHaveLength(expected)
    }
    expect(await w.vfs.readdir('/data')).toContain('/data/a.txt')
  })

  it('spends a grant handed to a line it then refuses', async () => {
    // The host allows the cat inline and the pass hands that grant to the
    // gate, which never runs: the rm behind it is refused first. Left
    // standing, the grant would pass the next cat of the secret on a nod
    // given to a line that never ran, so the refusal spends it and the
    // next cat is a question again.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell('cat /data/secret.txt && rm /data/prod/x.txt', { sessionId: 's' })
    expect(ran.exitCode).not.toBe(0)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
    const again = await w.shell('cat /data/secret.txt', { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(DEC.decode(again.stdout)).toBe('s\n')
    expect(asked).toHaveLength(2)
  })

  it('sweeps a grant the run never reaches when the line ends', async () => {
    // The host allows the cat inline and the line runs, but the failed cat
    // before it short-circuits the && and the gate that would have spent
    // the grant never runs. The line is over all the same, so the grant is
    // swept with it and the next cat is a question again.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell('cat /data/missing && cat /data/secret.txt', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stdout)).toBe('')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
    const again = await w.shell('cat /data/secret.txt', { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(DEC.decode(again.stdout)).toBe('s\n')
    expect(asked).toHaveLength(2)
  })

  it('sweeps a grant when the line fails before it runs', async () => {
    // The host allows the cat inline, and then the secret the echo reads
    // cannot be fetched, so the line fails between the preflight and the
    // run: no gate runs at all. The sweep covers that stretch too, or the
    // next cat would run on a nod given to a line that never did.
    registerSecrets('fake-dead-handoff', z.strictObject({}), () =>
      Promise.reject(new Error('connection refused')),
    )
    const asked: string[] = []
    const w = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        profiles: { r: PROFILE },
        onAsk: answering(asked, Outcome.ALLOW),
        env: { TOKEN: { from: 'fake-dead-handoff', ref: 'r' } },
      },
    )
    open.push(w)
    await w.shell('echo s > /data/secret.txt')
    w.createSession('s', { profile: 'r' })
    const ran = await w.shell('cat /data/secret.txt && echo $TOKEN', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stderr)).toBe('TOKEN: cannot fetch from fake-dead-handoff\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
    const again = await w.shell('cat /data/secret.txt', { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(DEC.decode(again.stdout)).toBe('s\n')
    expect(asked).toHaveLength(2)
  })

  it.each([
    'sleep 0.2 && cat /data/secret.txt &',
    'for i in 1 2; do sleep 0.2 && cat /data/secret.txt & done',
    'if sleep 0.2 && cat /data/secret.txt & then echo yes; fi',
    'until sleep 0.2 && cat /data/secret.txt & do echo no; done',
    '{ sleep 0.2 && cat /data/secret.txt & }',
    'f() { sleep 0.2 && cat /data/secret.txt & }; f',
    'echo λ🙂; f() { sleep 0.2 && cat /data/secret.txt & }; f',

    "eval 'sleep 0.2 && cat /data/secret.txt &'",
    `eval "eval 'sleep 0.2 && cat /data/secret.txt &'"`,
  ])('leaves a grant with a background job until the job ends: %s', async (line) => {
    // The line returns as soon as the job is launched, long before the
    // job's cat reaches its gate. The grant the host gave the line is the
    // job's to spend, so the line's end leaves it standing and the job's
    // end sweeps it; revoked with the line, the cat would have asked
    // again from inside the job.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toHaveLength(1)
    const waited = await w.shell('wait', { sessionId: 's' })
    expect(waited.exitCode).toBe(0)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('keeps an out-of-band grant with a nested background job', async () => {
    const w = await ws()
    const line = "eval 'sleep 0.2 && cat /data/secret.txt > /data/read.txt &'"
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(w.decisions.list('s')).toHaveLength(1)
    const elsewhere = await judged(w, 'cat /data/secret.txt', 's')
    expect(elsewhere[0]?.outcome).toBe(Outcome.ASK)
    const waited = await w.shell('wait', { sessionId: 's' })
    expect(waited.exitCode).toBe(0)
    expect(DEC.decode(await w.vfs.read('/data/read.txt'))).toBe('s\n')
    expect(w.decisions.list('s')).toEqual([])
  })

  it('hands a grant claimed for a nested line to the inner gate', async () => {
    // The pass reads into a substitution, so the cat inside $( ) is
    // judged and its grant claimed before the line runs. The inner line
    // re-enters the executor as a line of its own; with a hand-off
    // unlinked to the outer one, its gate read that claim as another
    // line's reservation and asked the human a second time for one run.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell('echo $(cat /data/secret.txt) && ls /data', { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout).startsWith('s\n')).toBe(true)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('runs a nested line on the answer its outer line was given', async () => {
    // Out of band: the question is the outer pass's, and the answer has
    // to reach the gate inside the substitution on the retry.
    const w = await ws()
    const line = 'echo $(cat /data/secret.txt) && ls /data'
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout).startsWith('s\n')).toBe(true)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('costs a nested line spelled twice two nods and no more', async () => {
    // The outer pass reads the line eval runs and claims one grant per
    // spelling. The inner line's own pass then finds both standing for
    // its two occurrences rather than asking for either again, and its
    // gates spend them.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell("eval 'cat /data/secret.txt && cat /data/secret.txt' && ls /data", {
      sessionId: 's',
    })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout).startsWith('s\ns\n')).toBe(true)
    expect(asked).toHaveLength(2)
    expect(w.decisions.list('s')).toEqual([])
  })

  it("keeps a whole line's first answer while its second waits", async () => {
    // A runtime that takes the line whole has no per-command gate, so
    // its admission pass is the only reader. Spending there, the cat's
    // answer was gone by the time the push's question came back, and
    // every retry asked for the cat again; the answers could never
    // accumulate to a line that runs.
    const box = new LineBox()
    const w = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        profiles: { r: PROFILE },
        runtimes: [box, 'workspace'],
      },
    )
    open.push(w)
    w.createSession('s', { profile: 'r' })
    const line = 'cat /data/secret.txt && git push origin main'
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const second = await w.shell(line, { sessionId: 's' })
    expect(second.exitCode).toBe(126)
    expect(second.refusal?.kind).toBe('pending')
    expect(w.decisions.list('s')).toHaveLength(2)
    expect(box.lines).toEqual([])
    await w.decisions.answer(second.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(box.lines).toEqual([line])
    expect(w.decisions.list('s')).toEqual([])
  })

  it('explains an expanded name as the route reads it', async () => {
    // The executor judges a name once expanded, so explain says nothing
    // about it; a runtime that takes the line whole reads it as typed and
    // refuses it under a rule, and explain then says exactly that.
    const line = 'X=echo; "$X" hi'
    for (const [whole, profile, code] of [
      [false, PROFILE, 0],
      [true, parseSessionProfile({}), 0],
      [true, PROFILE, 126],
    ] as const) {
      const w = new Workspace(
        { '/data': new RAMVFS() },
        {
          mode: MountMode.EXEC,
          profiles: { r: profile },
          ...(whole ? { runtimes: [new LineBox(), 'workspace'] } : {}),
        },
      )
      open.push(w)
      w.createSession('s', { profile: 'r' })
      const said = await judged(w, line, 's', whole)
      const ran = await w.shell(line, { sessionId: 's' })
      expect(ran.exitCode).toBe(code)
      expect(said.filter((e) => e.exitCode !== 0).map((e) => [e.exitCode, e.stderr])).toEqual(
        code === 0 ? [] : [[code, DEC.decode(ran.stderr)]],
      )
    }
  })

  it('explains a line the gate cannot read as refused', async () => {
    // Under a rule, a whole-line runtime's gate refuses a command whose lines
    // it cannot see into (a sourced file, a bash option mirage does not
    // read), and explain says exactly what the run says.
    const w = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        profiles: { r: parseSessionProfile({ commands: { allow: ['bash', 'source', 'rm'] } }) },
        runtimes: [new LineBox(), 'workspace'],
      },
    )
    open.push(w)
    w.createSession('s', { profile: 'r' })
    for (const line of [
      'source /data/f.sh',
      "bash --restricted -c 'rm /data/x'",
      "bash --rcfile $SKIP --version -c 'rm /data/x'",
      "bash --init-file $SKIP --help -c 'rm /data/x'",
      "bash --rcfile missing-* --version -c 'rm /data/x'",
    ]) {
      const said = await judged(w, line, 's', true)
      const ran = await w.shell(line, { sessionId: 's' })
      expect(ran.exitCode).toBe(126)
      expect(said.filter((e) => e.exitCode !== 0).map((e) => [e.exitCode, e.stderr])).toEqual([
        [126, DEC.decode(ran.stderr)],
      ])
    }
  })

  it('says what a whole-line gate refuses past the chain', async () => {
    // A runtime that takes the line whole walks, globs and changes directory
    // where no gate follows, so under a path rule its gate refuses a walk, a
    // glob and a command after a cd it cannot follow; explain said each
    // would run. A cd it can follow moves the path the rule reads, which the
    // gate read in the session's cwd and ran.
    const box = new LineBox()
    const w = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        profiles: {
          r: parseSessionProfile({
            commands: {
              allow: ['cat', 'cd', 'grep'],
              deny: [
                {
                  reason: 'sealed',
                  commands: { cat: ['/data/secret*'], grep: ['/data/secret*'] },
                },
              ],
            },
          }),
        },
        runtimes: [box, 'workspace'],
      },
    )
    open.push(w)
    w.createSession('s', { profile: 'r' })
    for (const [line, reason] of [
      ['grep -r x /data', 'walks a tree the gate cannot follow'],
      ['cat /data/*.txt', 'expands a pattern only the runtime can read'],
      ['cd "$D" && cat notes', 'runs after a cd the gate cannot follow'],
      ['cd /data && cat secret', 'sealed'],
    ] as const) {
      const said = await w.explain(line, 's')
      const ran = await w.shell(line, { sessionId: 's' })
      expect(ran.refusal?.reason).toBe(reason)
      expect([said.outcome, said.reason]).toEqual([Outcome.DENY, reason])
      expect([said.exitCode, said.stderr]).toEqual([ran.exitCode, DEC.decode(ran.stderr)])
    }
    expect(box.lines).toEqual([])
  })

  it('judges a whole line wherever a cd may leave it', async () => {
    // A cd may be skipped or fail, and a loop runs its body again from where
    // it ended: the gate judged each command only where the walk predicted it
    // stood, and admitted a read of the secret the box made from the cwd the
    // cd never left. A cd in a pipeline or sent to the background moves no
    // later run of the loop.
    const box = new LineBox()
    const w = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        profiles: {
          r: parseSessionProfile({
            commands: {
              allow: ['cat', 'cd', 'false', 'grep', 'true'],
              deny: [
                {
                  reason: 'sealed',
                  commands: { cat: ['/data/secret*'], grep: ['/data/secret*'] },
                },
              ],
            },
          }),
        },
        runtimes: [box, 'workspace'],
      },
    )
    open.push(w)
    w.createSession('s', { profile: 'r' })
    for (const [cwd, line, reason] of [
      ['/data', 'false && cd /data/public; cat secret', 'sealed'],
      ['/data', 'cd /data/public; cat secret', 'sealed'],
      [
        '/data/public',
        'for i in 1 2; do cat secret; cd /data; done',
        'runs after a cd the gate cannot follow',
      ],
    ] as const) {
      w.getSession('s').cwd = cwd
      const said = await w.explain(line, 's')
      const ran = await w.shell(line, { sessionId: 's' })
      expect(ran.refusal?.reason).toBe(reason)
      expect([said.outcome, said.reason]).toEqual([Outcome.DENY, reason])
    }
    expect(box.lines).toEqual([])
    const line = 'for i in 1 2; do cd /data | true; cd /data & cat notes; done'
    const said = await w.explain(line, 's')
    const ran = await w.shell(line, { sessionId: 's' })
    expect([said.exitCode, ran.refusal ?? null]).toEqual([0, null])
    expect(box.lines).toEqual([line])
  })

  it('has a coded policy judge a whole line where it may stand', async () => {
    // With no rule in force a coded policy is a whole line's only gate: it
    // was shown only the cwd a skipped cd predicted, nothing at all for a name
    // only the runtime expands, and none of the words after a line that may
    // move the cwd.
    const box = new LineBox()
    const w = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        policies: [new SealedSecret()],
        runtimes: [box, 'workspace'],
      },
    )
    open.push(w)
    w.getSession(w.defaultSessionId).cwd = '/data'
    for (const line of [
      'false && cd /data/public; cat secret.txt',
      '"$CMD" /data/secret.txt',
      "eval ':'; cat secret.txt",
    ]) {
      const said = await w.explain(line)
      const ran = await w.shell(line)
      expect(ran.refusal?.reason).toBe('sealed')
      expect([said.outcome, said.reason]).toEqual([Outcome.DENY, 'sealed'])
    }
    expect(box.lines).toEqual([])
  })

  it('reads nested loops once each', async () => {
    // A loop is read for a cd before it is walked; walking it to find out
    // doubled the work at every level, so 22 nested loops walked the innermost
    // command four million times before the line ran.
    const w = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    open.push(w)
    const line = `${'for a in; do '.repeat(22)}true${'; done'.repeat(22)}`
    const started = performance.now()
    const said = await w.explain(line)
    expect(said.exitCode).toBe(0)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('judges a held line as its runtime takes it', async () => {
    // A line the rules hold stays on its static bindings, whose runtime takes
    // it whole and refuses the walk before asking; explain read the held line
    // command by command and offered an approval the run never asks for.
    const box = new LineBox()
    const w = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        profiles: {
          r: parseSessionProfile({
            commands: {
              allow: ['grep'],
              ask: [{ reason: 'nod', commands: { grep: ['/data'] } }],
            },
          }),
        },
        runtimes: [box, 'workspace'],
      },
    )
    open.push(w)
    w.createSession('s', { profile: 'r' })
    const line = 'grep -r x /data'
    const reason = 'walks a tree the gate cannot follow'
    const said = await w.explain(line, 's')
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.refusal?.reason).toBe(reason)
    expect([said.outcome, said.reason]).toEqual([Outcome.DENY, reason])
    expect(box.lines).toEqual([])
  })

  it('reads a line as the runtime it is placed on', async () => {
    // A line placed on the workspace meets the per-command gate, which reads
    // a name once expanded, though the default runtime takes lines whole;
    // explain read the default and refused the name as unreadable.
    const w = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        profiles: { r: PROFILE },
        runtimes: [new LineBox(), 'workspace'],
        routePolicy: () => 'workspace',
      },
    )
    open.push(w)
    w.createSession('s', { profile: 'r' })
    const line = 'X=echo; "$X" hi'
    const said = await w.explain(line, 's')
    const ran = await w.shell(line, { sessionId: 's' })
    expect([ran.exitCode, DEC.decode(ran.stdout)]).toEqual([0, 'hi\n'])
    expect(said.exitCode).toBe(0)
    expect(commands(said.node).map((c) => c.exitCode)).toEqual(commands(said.node).map(() => 0))
  })

  it('leaves a path the pass cannot read to the gate', async () => {
    // Read as typed in the cwd the pass last knew, `$F` and a relative
    // word after `cd "$d"` matched the rule's glob, refusing whole lines
    // that remove only an allowed file, and `.` read as a mount root. A
    // path a word names outright stays read though it is the lost cwd;
    // a grep pattern spelling that cwd names no path.
    const sealed = parseSessionProfile({
      commands: { deny: [{ reason: 'sealed', commands: { grep: ['/data/prod'] } }] },
    })
    const w = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        profiles: { r: PROFILE, g: sealed },
      },
    )
    open.push(w)
    w.createSession('s', { profile: 'r' })
    w.createSession('g', { profile: 'g' })
    w.createSession('t')
    await w.shell('mkdir /data/prod; touch /data/x /data/w', { sessionId: 't' })
    for (const [session, line, code] of [
      ['s', 'cd /data/prod; F=/data/x; rm $F; echo ok', 0],
      ['s', 'cd /data/prod; d=/data; cd "$d" && rm w; echo ok', 0],
      ['s', 'd=/data; cd "$d" && rm /data/prod/y; echo ok', 1],
      ['s', 'cd /data/prod; mkdir v; cd v; d=/data; cd "$d" && rm -r /data/prod/v; echo ok', 1],
      [
        'g',
        'mkdir -p /data/q; cd /data/prod; d=/data/q; cd "$d" && grep -r -e /data/prod; echo ok',
        0,
      ],
      ['t', 'cd /data; d=prod; cd "$d" && tar -cf /data/t.tar . && echo ok', 0],
    ] as const) {
      const said = await judged(w, line, session)
      const ran = await w.shell(line, { sessionId: session })
      const err = DEC.decode(ran.stderr)
      expect([ran.exitCode, err]).toEqual([code, code === 0 ? '' : err])
      expect(DEC.decode(ran.stdout)).toBe(code === 0 ? 'ok\n' : '')
      expect(said.filter((e) => e.exitCode !== 0).map((e) => [e.exitCode, e.stderr])).toEqual(
        code === 0 ? [] : [[code, err]],
      )
    }
  })

  it('hands a borrow back when the job cannot be submitted', async () => {
    // The job borrows the line's hand-off before it is submitted, and
    // its runner hands it back. A submission that fails starts no
    // runner, so the borrow has to be handed back at the failure, or
    // the hand-off stays a holder short of release for good and its
    // grant is neither spent nor on offer to any later line.
    const asked: string[] = []
    let consoles = 0
    const w = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        profiles: { r: PROFILE },
        onAsk: answering(asked, Outcome.ALLOW),
        consoleFactory: (): JobConsole => {
          consoles += 1
          throw new Error('no console')
        },
      },
    )
    open.push(w)
    await w.shell('echo s > /data/secret.txt')
    w.createSession('s', { profile: 'r' })
    const ran = await w.shell('cat /data/secret.txt & ls /data', { sessionId: 's' })
    expect(ran.exitCode).not.toBe(0)
    expect(consoles).toBe(1)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
    const again = await w.shell('cat /data/secret.txt', { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(DEC.decode(again.stdout)).toBe('s\n')
    expect(asked).toHaveLength(2)
  })

  it('needs two answers for a command spelled twice on a line', async () => {
    // One out-of-band answer covers one spelling. Read for both, the first
    // cat would run and spend it before the second was found wanting, which
    // is the half-line the hold exists to prevent: the retry is held whole
    // until the second spelling has its own answer.
    const w = await ws()
    const line = 'cat /data/secret.txt && cat /data/secret.txt'
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const second = await w.shell(line, { sessionId: 's' })
    expect(second.exitCode).toBe(126)
    expect(DEC.decode(second.stdout)).toBe('')
    expect(second.refusal?.kind).toBe('pending')
    expect(w.decisions.list('s')).toHaveLength(2)
    await w.decisions.answer(second.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('s\ns\n')
    expect(w.decisions.list('s')).toEqual([])
  })

  it('holds the second of two lines judged at once on one nod', async () => {
    // One out-of-band answer, two identical compound lines executed
    // concurrently on the session. The line whose pass claims the grant
    // first runs; the other must be held whole, not run its ls and then
    // find the grant gone at its cat.
    const w = await ws()
    const line = 'ls /data && cat /data/secret.txt'
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const both = await Promise.all([
      w.shell(line, { sessionId: 's' }),
      w.shell(line, { sessionId: 's' }),
    ])
    const [ran, held] = [...both].sort((a, b) => a.exitCode - b.exitCode)
    if (ran === undefined || held === undefined) throw new Error('unreachable')
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('a.txt\nprod\nsecret.txt\ns\n')
    expect(held.exitCode).toBe(126)
    expect(DEC.decode(held.stdout)).toBe('')
    expect(held.refusal?.kind).toBe('pending')
  })

  it('spends a grant given before a line it then refuses', async () => {
    // The cat was answered out of band while the line waited; its retry is
    // then refused by the rm. That grant was given to this line as surely
    // as an inline one, so the refusal spends it too, and the next cat is a
    // question again rather than a run on a nod given to a line that never
    // ran.
    const w = await ws()
    const line = 'cat /data/secret.txt && rm /data/prod/x.txt'
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const retry = await w.shell(line, { sessionId: 's' })
    expect(retry.exitCode).not.toBe(0)
    expect(retry.refusal?.reason).toContain('production data is protected')
    expect(w.decisions.list('s')).toEqual([])
    const again = await w.shell('cat /data/secret.txt', { sessionId: 's' })
    expect(again.exitCode).toBe(126)
    expect(again.refusal?.kind).toBe('pending')
  })
})

describe('prejudge scope', () => {
  it('moves the commands inside a subshell when it begins with a cd', async () => {
    // The sibling test pins that the cd does not escape the subshell.
    // This one pins the other half: inside it, the cd still applies, so
    // the rule about /data/prod reads x.txt as the file it is. Reading a
    // subshell as "no cd applies" judged the command at the session cwd.
    const w = await ws()
    const ran = await w.shell('(cd /data/prod && rm x.txt)', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stderr)).toBe("rm: cannot remove 'x.txt': Permission denied\n")
    expect(await w.vfs.readdir('/data/prod')).toContain('/data/prod/x.txt')
  })

  it('refuses a one-command line from inside the shell', async () => {
    // Nothing runs before a single command, so there is no hold to buy
    // and the per-command gate answers instead. That is the more
    // faithful answer, not just the cheaper one: the gate refuses from
    // inside the shell, so `2>&1` still moves the message, where this
    // pass answers above the redirect layer and would leave it on
    // stderr.
    const w = await ws()
    const ran = await w.shell('rm /data/prod/x.txt 2>&1', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stdout)).toBe("rm: cannot remove '/data/prod/x.txt': Permission denied\n")
    expect(DEC.decode(ran.stderr)).toBe('')
  })

  it("does not run a command expanded at run time on a judged spelling's nod", async () => {
    // The pass reads the literal cat and claims the answer for it; the
    // first cat's operand expands at run time into the same command. Read
    // by spelling, that gate found the literal's grant and read the secret
    // before its own question was ever put, and the literal then asked
    // again. Bound to its occurrence, the grant is the literal's alone:
    // the expanded command asks, its question holds the line, and the
    // retry runs both on their own answers.
    const w = await ws()
    const line = 'F=/data/secret.txt; cat $F && cat /data/secret.txt'
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const second = await w.shell(line, { sessionId: 's' })
    expect(second.exitCode).toBe(126)
    expect(DEC.decode(second.stdout)).toBe('')
    expect(second.refusal?.kind).toBe('pending')
    expect(w.decisions.list('s')).toHaveLength(2)
    await w.decisions.answer(second.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('s\ns\n')
    expect(w.decisions.list('s')).toEqual([])
  })

  it('reads one body under two words as two occurrences', async () => {
    // The same substitution twice on a line is two questions, and each
    // nested line spends its own: the second body cannot be answered by
    // the first body's nod, nor ask a third time.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell('echo $(cat /data/secret.txt) $(cat /data/secret.txt) && ls /data', {
      sessionId: 's',
    })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout).startsWith('s s\n')).toBe(true)
    expect(asked).toHaveLength(2)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('reads the words command hands on as command spells them', async () => {
    // command re-runs its operands as one line, joined with shellJoin so
    // an operand holding a space survives the re-parse. The pass has to
    // read the words the same way, or the occurrence it claims the
    // answer for is not the one the nested gate computes, and the cat
    // asks a second time after the echo has already run.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    await w.shell("echo s > '/data/secret file'")
    const ran = await w.shell("echo x && command cat '/data/secret file'", { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('x\ns\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it("keeps a job's grant reserved while the line that launched it is held", async () => {
    // The job is launched on the grant the pass claimed for its cat, and
    // the foreground cat expands into a question that holds the line. A
    // hold that let go of the job's grant with the line's left it
    // standing for anyone while the job slept, so a line judged then ran
    // on it and the job asked again. The grant is the job's own: the
    // other line asks, and the job runs on its nod.
    const w = await ws()
    const line = 'F=/data/secret.txt; sleep 0.5 && cat /data/secret.txt & cat $F'
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const held = await w.shell(line, { sessionId: 's' })
    expect(held.exitCode).toBe(126)
    expect(held.refusal?.kind).toBe('pending')
    const other = await w.shell('cat /data/secret.txt', { sessionId: 's' })
    expect(other.exitCode).toBe(126)
    expect(other.refusal?.kind).toBe('pending')
    const waited = await w.shell('wait', { sessionId: 's' })
    expect(waited.exitCode).toBe(0)
    expect(w.decisions.pending('s')).toHaveLength(w.decisions.list('s').length)
  })

  it('holds a line with touching backtick pairs as the lines they run', async () => {
    // tree-sitter lexes the two pairs as one node whose subtree is one
    // merged command that never runs. Judged on that spelling, the pass
    // saw no readable cat and nothing held the line: the echo ran, and
    // only then did the cat's gate, running its own pair as a line, ask.
    // Read as the lines the evaluator runs, the pass asks first and
    // holds the whole line.
    const w = await ws()
    const line = 'echo x && echo `cat /data/secret.txt` `echo ok`'
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(DEC.decode(first.stdout)).toBe('')
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('x\ns ok\n')
    expect(w.decisions.list('s')).toEqual([])
  })

  it('reads two backtick pairs of one node as two occurrences', async () => {
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell('echo `cat /data/secret.txt` `cat /data/secret.txt`', {
      sessionId: 's',
    })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('s s\n')
    expect(asked).toHaveLength(2)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('asks once for an operand holding a multibyte character', async () => {
    // The nested gate places the cat where the parser does; the pass's
    // claim has to end at the same count or the grant is hidden from the
    // gate and the cat asks again after the echo has run.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    await w.shell('echo s > /data/secrét')
    const ran = await w.shell('echo x && command cat /data/secrét', { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('x\ns\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('runs a pair after a multibyte character on its own nod', async () => {
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell('echo `echo é` `cat /data/secret.txt`', { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('é s\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it.each([
    'for i in 1 2; do touch /data/mark.txt; cat /data/secret.txt; done',
    'for i in 1 2; do cat /data/secret.txt; done',
  ])('runs every visit of a command in a loop on one nod: %s', async (line) => {
    // The loop body is one place on the line, visited twice. The grant for
    // the cat is bound to that place until the line ends, whether the pass
    // claimed it or the first gate to reach it did (the pass leaves a
    // one-command body to the gate), so the second iteration runs on it
    // instead of asking again after the touch ran once more.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('s\ns\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('replays a held loop on the one answer it was given', async () => {
    const w = await ws()
    const line = 'for i in 1 2; do touch /data/mark.txt; cat /data/secret.txt; done'
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(await w.vfs.readdir('/data')).not.toContain('/data/mark.txt')
    const [pending] = w.decisions.pending()
    expect(w.decisions.pending()).toHaveLength(1)
    await w.decisions.answer(pending?.id ?? '', Outcome.ALLOW)
    const again = await w.shell(line, { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(DEC.decode(again.stdout)).toBe('s\ns\n')
    expect(w.decisions.list('s')).toEqual([])
  })

  it.each([
    'touch /data/mark.txt && echo /data/secret.txt | xargs cat',
    'F=/data/secret.txt; touch /data/mark.txt; cat $F',
  ])('asks about a spelling the runtime completes at the gate: %s', async (line) => {
    // The pass reads `xargs cat` as a bare cat and `cat $F` as the word
    // typed, and the gate reads neither: xargs appends its items and $F
    // expands. A question asked here about either spelling would be
    // answered for words that never run, and the gate would ask again
    // about the words that do, so the pass leaves the question to the
    // gate and the human is asked once, about the real operand. The touch
    // has run by then; the hold does not reach a spelling the runtime
    // completes.
    const seen: string[][] = []
    const w = await inlineWs((record) => {
      seen.push([record.command, ...record.argv])
      return Promise.resolve({ ...record, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    }, ASK_CAT)
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('s\n')
    expect(seen).toEqual([['cat', '/data/secret.txt']])
    expect(w.decisions.list('s')).toEqual([])
  })

  it.each([
    'touch /data/mark.txt && echo /data/secret.txt | xargs cat',
    'F=/data/secret.txt; touch /data/mark.txt; cat $F',
  ])('holds the line for a deny on a spelling the runtime completes: %s', async (line) => {
    // A deny speaks on the command name alone, which the pass can read
    // whatever the runtime appends, so it still refuses the whole line
    // before the touch runs.
    const w = await inlineWs(answering([], Outcome.ALLOW), DENY_CAT)
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(126)
    expect(DEC.decode(ran.stderr)).toBe('cat: Permission denied\n')
    expect(await w.vfs.readdir('/data')).not.toContain('/data/mark.txt')
  })

  it('runs every batch xargs hands on on one nod', async () => {
    // Each batch xargs hands on is a nested line of its own, evaluated
    // from the one xargs node, so every batch's cat stands at the same
    // place. What the first batch's gate claims is handed to the outer
    // line when the batch ends, and the second batch runs on it.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell("printf '/data/secret.txt /data/secret.txt' | xargs -n1 cat", {
      sessionId: 's',
    })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('s\ns\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('replays every batch of a held xargs line on one answer', async () => {
    const w = await ws()
    const line = "printf '/data/secret.txt /data/secret.txt' | xargs -n1 cat"
    const first = await w.shell(line, { sessionId: 's' })
    expect(first.refusal?.kind).toBe('pending')
    const [pending] = w.decisions.pending()
    expect(w.decisions.pending()).toHaveLength(1)
    await w.decisions.answer(pending?.id ?? '', Outcome.ALLOW)
    const again = await w.shell(line, { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(DEC.decode(again.stdout)).toBe('s\ns\n')
    expect(w.decisions.list('s')).toEqual([])
  })

  it('runs every job a loop launches on one nod', async () => {
    // The loop body launches a job from one place twice through eval.
    // Each job takes a copy of the grant claimed
    // for that place, the line's end leaves the grant standing while a job
    // holds it, and the last job's end spends it.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell(
      "for i in 1 2; do eval 'sleep 0.2 && cat /data/secret.txt >> /data/read.txt &'; done",
      { sessionId: 's' },
    )
    expect(ran.exitCode).toBe(0)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toHaveLength(1)
    const waited = await w.shell('wait', { sessionId: 's' })
    expect(waited.exitCode).toBe(0)
    expect(DEC.decode(await w.vfs.read('/data/read.txt'))).toBe('s\ns\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it.each([
    "sleep 0.2 && eval 'cat /data/secret.txt' &",
    'sleep 0.2 && echo $(cat /data/secret.txt) &',
  ])('stands a line a job evaluates late under the job: %s', async (line) => {
    // The job outlives the line, and only then hands a line on (eval) or
    // expands one ($( )). That line stands under the job's hand-off,
    // which holds the grant the pass claimed for its cat, so the gate
    // runs on it and asks nothing more, and the job's end spends it.
    // Under the finished line's hand-off instead, the gate could not see
    // the job's grant and asked again, and what it then claimed went
    // back to a hand-off nothing revokes, standing for good.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(asked).toHaveLength(1)
    const waited = await w.shell('wait', { sessionId: 's' })
    expect(waited.exitCode).toBe(0)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it("leaves what a job's late gate claims to the job to spend", async () => {
    // xargs completes cat's words at run time, so the pass leaves the
    // question to the gate, which asks from inside the job after the
    // line has returned. The answer is claimed for the batch's line and
    // handed up to the job's hand-off, whose end spends it; parked on
    // the finished line's, it would stand unspent for good.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.shell('sleep 0.2 && echo /data/secret.txt | xargs cat &', {
      sessionId: 's',
    })
    expect(ran.exitCode).toBe(0)
    expect(asked).toEqual([])
    const waited = await w.shell('wait', { sessionId: 's' })
    expect(waited.exitCode).toBe(0)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it.each(['c && c', 'c; c', "eval 'c && c'", 'd && d'])(
    'reads each invocation of an alias as a place of its own: %s',
    async (line) => {
      // An invocation reads its rewritten line as a line of its own under
      // the word that named it, so two invocations on one line are two
      // places and two questions, as the spelled-out `cat ... && cat ...`
      // is, through an alias of an alias as well. Run on the line's own
      // hand-off instead, both reads stood at the same offsets of the
      // same text, and the second ran on the first's nod.
      const asked: string[] = []
      const w = await aliased(asked)
      const ran = await w.shell(line, { sessionId: 's' })
      expect(ran.exitCode).toBe(0)
      expect(DEC.decode(ran.stdout)).toBe('s\ns\n')
      expect(asked).toHaveLength(2)
      expect(w.decisions.list('s')).toEqual([])
    },
  )

  it('runs one alias invocation reached twice on one nod', async () => {
    // A loop body visits one invocation twice: the same word at the same
    // place reads the same line, so the second visit runs on what the
    // first claimed and handed back to the line, and the line's end
    // spends it.
    const asked: string[] = []
    const w = await aliased(asked)
    const ran = await w.shell('for i in 1 2; do c; done', { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('s\ns\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('hands what an alias a job runs late claims to the job', async () => {
    // The job expands the alias after the line has returned, so the
    // rewritten line stands under the job's hand-off, not the finished
    // line's: what its gate claims is handed to the job, and the job's
    // end spends it rather than leaving it standing for good.
    const asked: string[] = []
    const w = await aliased(asked)
    const ran = await w.shell('sleep 0.2 && c &', { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    const waited = await w.shell('wait', { sessionId: 's' })
    expect(waited.exitCode).toBe(0)
    expect(DEC.decode(waited.stdout)).toBe('s\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('asks about a mapfile callback at the gate', async () => {
    // mapfile runs its callback with the index and the record after it,
    // so the callback as typed is a spelling the runtime completes, like
    // the words xargs hands on: the pass leaves its question to the gate,
    // which asks once about the words that run.
    const seen: string[][] = []
    const w = await inlineWs((record) => {
      seen.push([record.command, ...record.argv])
      return Promise.resolve({ ...record, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    }, ASK_CAT)
    await w.shell(
      "touch /data/mark.txt && printf 'x\\n' | mapfile -t -c 1 -C 'cat /data/secret.txt'",
      {
        sessionId: 's',
      },
    )
    expect(seen).toEqual([['cat', '/data/secret.txt', '0', 'x']])
    expect(w.decisions.list('s')).toEqual([])
  })
})

class AskRm implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    return ctx.command === 'rm' ? { kind: 'ask', reason: 'sign-off' } : null
  }
}

class DenyRm implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    return ctx.command === 'rm' ? { kind: 'deny', reason: 'no' } : null
  }
}

class Broken implements Policy {
  preCommand(): Action | null {
    throw new Error('broken')
  }
}

describe('explain answers and the op form', () => {
  // Twin of test_explain_reads_a_scope_that_spells_a_byte_past_utf8: `env`
  // runs printf as a scope of its own, spelled from the expanded words,
  // and `$'\xff'` expands to a byte no UTF-8 encodes.
  it('reads a scope that spells a byte past UTF-8', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const said = await ws.explain("env printf '%d\\n' $'\\x27\\xff'")
      const [env] = said.node.children
      const [scope] = env?.children ?? []
      const [printf] = scope?.children ?? []
      expect([
        said.exitCode,
        printf !== undefined && 'command' in printf ? printf.command : null,
      ]).toEqual([0, 'printf'])
      expect(printf !== undefined && 'command' in printf ? printf.words.at(-1)?.text : null).toBe(
        "'\udcff",
      )
    } finally {
      await ws.close()
    }
  })

  it("shows every policy's answer in chain order", async () => {
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        policies: [new AskRm(), new DenyRm()],
      },
    )
    try {
      const said = await ws.explain('rm /data/x')
      const [rm] = said.node.children
      // The Ask comes first and is still shown: no answer stops the loop,
      // and the Deny is what the line meets.
      expect(rm !== undefined && 'command' in rm ? rm.answers : null).toEqual([
        { kind: 'ask', reason: 'sign-off', policy: 'AskRm' },
        { kind: 'deny', reason: 'no', policy: 'DenyRm' },
      ])
      // A policy's refusal is the command's: the line itself runs.
      expect(
        rm !== undefined && 'command' in rm ? [rm.exitCode, rm.refusal?.reason] : null,
      ).toEqual([126, 'no'])
      expect([said.outcome, said.exitCode]).toEqual([Outcome.ALLOW, 0])
      expect(await new Session(ws, null).explain.shell('rm /data/x')).toEqual(said)
    } finally {
      await ws.close()
    }
  })

  it('explains a policy that fails as a deny', async () => {
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, policies: [new Broken()] },
    )
    try {
      const said = await ws.explain('echo hi')
      const ran = await ws.shell('echo hi')
      const [echo] = said.node.children
      if (echo === undefined || !('command' in echo)) throw new Error('no command node')
      expect([echo.outcome, echo.refusal?.kind]).toEqual([Outcome.DENY, 'failed'])
      expect([echo.exitCode, echo.stderr]).toEqual([ran.exitCode, DEC.decode(ran.stderr)])
    } finally {
      await ws.close()
    }
  })
})
