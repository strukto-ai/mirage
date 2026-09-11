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

import { Outcome, Scope } from '../../policy/index.ts'
import type { Action, AskHandler, CommandContext, Policy } from '../../policy/index.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { Runtime } from '../../runtime/base.ts'
import { LINE_EXECUTOR, type LineExecutor } from '../../runtime/mixin.ts'
import type { RunResult } from '../../runtime/types.ts'
import type { JobConsole } from '../../shell/console/index.ts'
import { registerSecrets } from '../../secrets/registry.ts'
import { MountMode } from '../../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { Workspace } from '../workspace/workspace.ts'

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
  const parser = await getTestParser()
  const w = new Workspace(
    { '/data': new RAMResource() },
    { mode: MountMode.WRITE, shellParser: parser, profiles: { r: PROFILE } },
  )
  open.push(w)
  await w.execute('mkdir -p /data/prod')
  await w.execute('echo x > /data/prod/x.txt')
  await w.execute('echo a > /data/a.txt')
  await w.execute('echo s > /data/secret.txt')
  w.createSession('s', { profile: 'r' })
  return w
}

/**
 * The same world as `ws`, with a host that answers an ask inline, under
 * `profile` for session `s`.
 */
async function inlineWs(onAsk: AskHandler, profile = PROFILE): Promise<Workspace> {
  const parser = await getTestParser()
  const w = new Workspace(
    { '/data': new RAMResource() },
    { mode: MountMode.WRITE, shellParser: parser, profiles: { r: profile }, onAsk },
  )
  open.push(w)
  await w.execute('mkdir -p /data/prod')
  await w.execute('echo x > /data/prod/x.txt')
  await w.execute('echo a > /data/a.txt')
  await w.execute('echo s > /data/secret.txt')
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
  const defined = await w.execute("shopt -s expand_aliases; alias c='cat /data/secret.txt' d=c", {
    sessionId: 's',
  })
  expect(defined.exitCode).toBe(0)
  return w
}

class LineBox extends Runtime implements LineExecutor {
  readonly [LINE_EXECUTOR] = true as const
  readonly name = 'sandbox'
  declare captures: readonly string[]
  lines: string[] = []

  constructor() {
    super({ captures: ['*'] })
  }

  runLine(line: string): Promise<RunResult> {
    this.lines.push(line)
    return Promise.resolve({ stdout: ENC.encode(`box:${line}`), stderr: null, exitCode: 0 })
  }
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
    const [allowed] = await w.explain('cat /data/a.txt', 's')
    expect(allowed?.outcome).toBe(Outcome.ALLOW)
    expect(allowed?.exitCode).toBe(0)
    expect(allowed?.rule).toBeNull()

    const [denied] = await w.explain('rm /data/prod/x.txt', 's')
    expect(denied?.outcome).toBe(Outcome.DENY)
    expect(denied?.reason).toBe('production data is protected')
    expect(denied?.source).toBe('top')
    expect(denied?.matchedPath).toBe('/data/prod/x.txt')

    const [asked] = await w.explain('git push origin main', 's')
    expect(asked?.outcome).toBe(Outcome.ASK)
    expect(asked?.reason).toBe('pushes need sign-off')
  })

  it('reports a word the session cannot see as deny at 127', async () => {
    // Both refusals the allow list produces are DENY with no rule; the
    // exit code is what separates a head word the session cannot see
    // from a line no allow entry covers.
    const w = await ws()
    const [missing] = await w.explain('gerp x', 's')
    expect(missing?.outcome).toBe(Outcome.DENY)
    expect(missing?.rule).toBeNull()
    expect(missing?.source).toBe('commands.allow')
    expect(missing?.exitCode).toBe(127)
    expect(missing?.stderr).toBe('gerp: command not found\n')
  })

  it('reads every command of a line', async () => {
    const w = await ws()
    const [first, second] = await w.explain('cat /data/a.txt && rm /data/prod/x.txt', 's')
    expect([first?.command, first?.outcome]).toEqual(['cat', Outcome.ALLOW])
    expect([second?.command, second?.outcome]).toEqual(['rm', Outcome.DENY])
  })

  it('says exactly what the run would say', async () => {
    const w = await ws()
    for (const line of ['rm /data/prod/x.txt', 'git push origin main', 'gerp x']) {
      const ran = await w.execute(line, { sessionId: 's' })
      const [said] = await w.explain(line, 's')
      expect(said?.exitCode).toBe(ran.exitCode)
      expect(said?.stderr).toBe(DEC.decode(ran.stderr))
    }
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
    expect((await w.fs.readdir('/data')).sort()).toEqual([
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
    const ran = await w.execute('rm /data/a.txt && rm /data/prod/x.txt', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stderr)).toBe('rm: /data/prod/x.txt: production data is protected\n')
    expect(await w.fs.readdir('/data')).toContain('/data/a.txt')
  })

  it('leaves a line alone when a word is simply not installed', async () => {
    // A head word the session cannot see is a routing miss, not a
    // verdict, so it stays bash. A typo must not cost an agent the work
    // the line already did.
    const w = await ws()
    const ran = await w.execute('rm /data/a.txt && gerp x', { sessionId: 's' })
    expect(ran.exitCode).toBe(127)
    expect(DEC.decode(ran.stderr)).toBe('gerp: command not found\n')
    expect(await w.fs.readdir('/data')).not.toContain('/data/a.txt')
  })

  it('holds a line with an asked command until it is answered', async () => {
    const w = await ws()
    const line = 'rm /data/a.txt && cat /data/secret.txt'
    const ran = await w.execute(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(126)
    expect(await w.fs.readdir('/data')).toContain('/data/a.txt')
    // Exactly one request, from the one pass that judged the line.
    const [pending] = w.decisions.pending()
    expect(w.decisions.pending()).toHaveLength(1)
    await w.decisions.answer(pending?.id ?? '', Outcome.ALLOW, Scope.ONCE)
    // The whole line replays, which is only sound because none of it
    // ran the first time, and the grant is spent exactly once even
    // though two passes now read it.
    const again = await w.execute(line, { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(await w.fs.readdir('/data')).not.toContain('/data/a.txt')
    expect(w.decisions.pending()).toEqual([])
  })

  it('moves what later rules read when the line begins with a cd', async () => {
    // The line is judged before it runs, so the pass has to walk a
    // literal `cd` itself or a rule about /data/prod would answer about
    // whatever directory the session happened to be in.
    const w = await ws()
    const ran = await w.execute('cd /data/prod && rm x.txt', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stderr)).toBe('rm: x.txt: production data is protected\n')
  })

  it('reads a cd the same way the run does', async () => {
    // explain and the pass that decides the line share one walk, so a
    // host asking about a line and the agent typing it cannot be told
    // different things about where the line ends up.
    const w = await ws()
    const line = 'cd /data/prod && rm x.txt'
    const [, removed] = await w.explain(line, 's')
    expect(removed?.outcome).toBe(Outcome.DENY)
    const ran = await w.execute(line, { sessionId: 's' })
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
    const ran = await w.execute('S=/data/secret.txt; rm /data/a.txt && cat $S', {
      sessionId: 's',
    })
    expect(ran.exitCode).toBe(126)
    expect(await w.fs.readdir('/data')).not.toContain('/data/a.txt')
    expect(w.decisions.pending()).toHaveLength(1)
  })

  it('does not move later commands for a cd inside a subshell', async () => {
    // bash restores the cwd when the subshell exits, so carrying the cd
    // past it refused a line that was never going to touch /data/prod.
    const w = await ws()
    const ran = await w.execute('(cd /data/prod && ls) && rm x.txt', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stderr)).not.toContain('production data is protected')
    expect(await w.fs.readdir('/data/prod')).toContain('/data/prod/x.txt')
  })

  it('shows a line running once the session holds a grant', async () => {
    const w = await ws()
    const ran = await w.execute('git push origin main', { sessionId: 's' })
    expect(ran.exitCode).toBe(126)
    const [pending] = w.decisions.pending()
    await w.decisions.answer(pending?.id ?? '', Outcome.ALLOW, Scope.SESSION)
    // The document still says ask, because that is what it says; the
    // exit code says 0, because that is what the line would now do.
    const [asked] = await w.explain('git push origin main', 's')
    expect(asked?.outcome).toBe(Outcome.ASK)
    expect(asked?.exitCode).toBe(0)
    expect(asked?.stderr).toBe('')
  })
})

const SEALED = parseSessionProfile({
  commands: {
    allow: ['ls', 'cat', 'rm', 'mkdir', 'echo'],
    deny: [{ reason: 'sealed until review', paths: ['/data/prod/*'] }],
  },
})

async function sealedWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const w = new Workspace(
    { '/data': new RAMResource() },
    { mode: MountMode.WRITE, shellParser: parser, profiles: { r: SEALED } },
  )
  open.push(w)
  await w.execute('mkdir -p /data/prod')
  await w.execute('echo x > /data/prod/x.txt')
  await w.execute('echo a > /data/a.txt')
  w.createSession('s', { profile: 'r' })
  return w
}

class NoCat implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    if (ctx.command !== 'cat') return null
    return { kind: 'deny', reason: 'cat is refused by policy', scope: 'command' }
  }
}

describe('prejudge', () => {
  it('reads the statement’s redirect target', async () => {
    // The shell opens a redirect on its own fd, outside the window the
    // command's own gate covers, so admission reads the target as a word
    // of the command. The dry run has to read it the same way or it
    // answers ALLOW for a line the run refuses.
    const w = await sealedWs()
    const [said] = await w.explain('echo x > /data/prod/x.txt', 's')
    expect(said?.outcome).toBe(Outcome.DENY)
    expect(said?.reason).toBe('sealed until review')
  })

  it('holds the whole line for a rule on a redirect target', async () => {
    // `a && b > f` parses as one redirected statement wrapping the list,
    // so the target belongs to the last command of the chain, not the
    // statement's first child.
    const w = await sealedWs()
    const ran = await w.execute('rm /data/a.txt && echo x > /data/prod/x.txt', { sessionId: 's' })
    expect(ran.exitCode).not.toBe(0)
    expect(DEC.decode(ran.stderr)).toContain('sealed until review')
    expect(await w.fs.readdir('/data')).toContain('/data/a.txt')
  })

  it('holds the line for a coded policy with no document', async () => {
    // A session with no permissions document still runs under whatever
    // policies the deployment registered, and one is always registered
    // (MountRootPolicy). Returning early on `commands === null` held the
    // line for a document and left a policy with the half-line behavior
    // the pass exists to remove.
    const parser = await getTestParser()
    const w = new Workspace(
      { '/data': new RAMResource() },
      { mode: MountMode.WRITE, shellParser: parser, policies: [new NoCat()] },
    )
    open.push(w)
    await w.execute('echo a > /data/a.txt')
    await w.execute('echo b > /data/b.txt')
    const ran = await w.execute('rm /data/a.txt && cat /data/b.txt')
    expect(ran.exitCode).not.toBe(0)
    expect(DEC.decode(ran.stderr)).toBe('cat: Permission denied\n')
    expect(ran.refusal?.reason).toBe('cat is refused by policy')
    expect(await w.fs.readdir('/data')).toContain('/data/a.txt')
  })

  it('does not end the scan when an ask is answered inline', async () => {
    // The host answers the cat inline, so admit admits it. The rest of
    // the line has not been judged yet: reading that admission as "the
    // line is fine" let the later deny run behind an approval, which is
    // the half-line behavior in its worst form, since the agent was told
    // yes.
    const w = await inlineWs(answering([], Outcome.ALLOW))
    const ran = await w.execute('cat /data/secret.txt && rm /data/prod/x.txt', { sessionId: 's' })
    expect(ran.exitCode).not.toBe(0)
    expect(DEC.decode(ran.stderr)).toContain('production data is protected')
    expect(DEC.decode(ran.stdout)).not.toContain('s')
    expect(await w.fs.readdir('/data/prod')).toContain('/data/prod/x.txt')
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
    const ran = await w.execute(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('s\n')
    expect(asked).toHaveLength(1)
    await w.execute('echo a > /data/a.txt', { sessionId: 's' })
    const again = await w.execute(line, { sessionId: 's' })
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
      const ran = await w.execute(line, { sessionId: 's' })
      expect(ran.exitCode).toBe(126)
      expect(asked).toHaveLength(expected)
    }
    expect(await w.fs.readdir('/data')).toContain('/data/a.txt')
  })

  it('spends a grant handed to a line it then refuses', async () => {
    // The host allows the cat inline and the pass hands that grant to the
    // gate, which never runs: the rm behind it is refused first. Left
    // standing, the grant would pass the next cat of the secret on a nod
    // given to a line that never ran, so the refusal spends it and the
    // next cat is a question again.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.execute('cat /data/secret.txt && rm /data/prod/x.txt', { sessionId: 's' })
    expect(ran.exitCode).not.toBe(0)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
    const again = await w.execute('cat /data/secret.txt', { sessionId: 's' })
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
    const ran = await w.execute('cat /data/missing && cat /data/secret.txt', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stdout)).toBe('')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
    const again = await w.execute('cat /data/secret.txt', { sessionId: 's' })
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
    const parser = await getTestParser()
    const w = new Workspace(
      { '/data': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: { r: PROFILE },
        onAsk: answering(asked, Outcome.ALLOW),
        env: { TOKEN: { from: 'fake-dead-handoff', ref: 'r' } },
      },
    )
    open.push(w)
    await w.execute('echo s > /data/secret.txt')
    w.createSession('s', { profile: 'r' })
    const ran = await w.execute('cat /data/secret.txt && echo $TOKEN', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stderr)).toBe('TOKEN: cannot fetch from fake-dead-handoff\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
    const again = await w.execute('cat /data/secret.txt', { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(DEC.decode(again.stdout)).toBe('s\n')
    expect(asked).toHaveLength(2)
  })

  it.each([
    'sleep 0.2 && cat /data/secret.txt &',
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
    const ran = await w.execute(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toHaveLength(1)
    const waited = await w.execute('wait', { sessionId: 's' })
    expect(waited.exitCode).toBe(0)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('keeps an out-of-band grant with a nested background job', async () => {
    const w = await ws()
    const line = "eval 'sleep 0.2 && cat /data/secret.txt > /data/read.txt &'"
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.execute(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(w.decisions.list('s')).toHaveLength(1)
    const elsewhere = await w.explain('cat /data/secret.txt', 's')
    expect(elsewhere[0]?.outcome).toBe(Outcome.ASK)
    const waited = await w.execute('wait', { sessionId: 's' })
    expect(waited.exitCode).toBe(0)
    expect(await w.fs.readFileText('/data/read.txt')).toBe('s\n')
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
    const ran = await w.execute('echo $(cat /data/secret.txt) && ls /data', { sessionId: 's' })
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
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.execute(line, { sessionId: 's' })
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
    const ran = await w.execute("eval 'cat /data/secret.txt && cat /data/secret.txt' && ls /data", {
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
    const parser = await getTestParser()
    const w = new Workspace(
      { '/data': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        profiles: { r: PROFILE },
        runtimes: [box, 'vfs'],
      },
    )
    open.push(w)
    w.createSession('s', { profile: 'r' })
    const line = 'cat /data/secret.txt && git push origin main'
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const second = await w.execute(line, { sessionId: 's' })
    expect(second.exitCode).toBe(126)
    expect(second.refusal?.kind).toBe('pending')
    expect(w.decisions.list('s')).toHaveLength(2)
    expect(box.lines).toEqual([])
    await w.decisions.answer(second.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.execute(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(box.lines).toEqual([line])
    expect(w.decisions.list('s')).toEqual([])
  })

  it('hands a borrow back when the job cannot be submitted', async () => {
    // The job borrows the line's hand-off before it is submitted, and
    // its runner hands it back. A submission that fails starts no
    // runner, so the borrow has to be handed back at the failure, or
    // the hand-off stays a holder short of release for good and its
    // grant is neither spent nor on offer to any later line.
    const asked: string[] = []
    const parser = await getTestParser()
    let consoles = 0
    const w = new Workspace(
      { '/data': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: { r: PROFILE },
        onAsk: answering(asked, Outcome.ALLOW),
        consoleFactory: (): JobConsole => {
          consoles += 1
          throw new Error('no console')
        },
      },
    )
    open.push(w)
    await w.execute('echo s > /data/secret.txt')
    w.createSession('s', { profile: 'r' })
    const ran = await w.execute('cat /data/secret.txt & ls /data', { sessionId: 's' })
    expect(ran.exitCode).not.toBe(0)
    expect(consoles).toBe(1)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
    const again = await w.execute('cat /data/secret.txt', { sessionId: 's' })
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
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const second = await w.execute(line, { sessionId: 's' })
    expect(second.exitCode).toBe(126)
    expect(DEC.decode(second.stdout)).toBe('')
    expect(second.refusal?.kind).toBe('pending')
    expect(w.decisions.list('s')).toHaveLength(2)
    await w.decisions.answer(second.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.execute(line, { sessionId: 's' })
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
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const both = await Promise.all([
      w.execute(line, { sessionId: 's' }),
      w.execute(line, { sessionId: 's' }),
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
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const retry = await w.execute(line, { sessionId: 's' })
    expect(retry.exitCode).not.toBe(0)
    expect(DEC.decode(retry.stderr)).toContain('production data is protected')
    expect(w.decisions.list('s')).toEqual([])
    const again = await w.execute('cat /data/secret.txt', { sessionId: 's' })
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
    const ran = await w.execute('(cd /data/prod && rm x.txt)', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stderr)).toBe('rm: x.txt: production data is protected\n')
    expect(await w.fs.readdir('/data/prod')).toContain('/data/prod/x.txt')
  })

  it('refuses a one-command line from inside the shell', async () => {
    // Nothing runs before a single command, so there is no hold to buy
    // and the per-command gate answers instead. That is the more
    // faithful answer, not just the cheaper one: the gate refuses from
    // inside the shell, so `2>&1` still moves the message, where this
    // pass answers above the redirect layer and would leave it on
    // stderr.
    const w = await ws()
    const ran = await w.execute('rm /data/prod/x.txt 2>&1', { sessionId: 's' })
    expect(ran.exitCode).toBe(1)
    expect(DEC.decode(ran.stdout)).toBe('rm: /data/prod/x.txt: production data is protected\n')
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
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const second = await w.execute(line, { sessionId: 's' })
    expect(second.exitCode).toBe(126)
    expect(DEC.decode(second.stdout)).toBe('')
    expect(second.refusal?.kind).toBe('pending')
    expect(w.decisions.list('s')).toHaveLength(2)
    await w.decisions.answer(second.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.execute(line, { sessionId: 's' })
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
    const ran = await w.execute(
      'echo $(cat /data/secret.txt) $(cat /data/secret.txt) && ls /data',
      {
        sessionId: 's',
      },
    )
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
    await w.execute("echo s > '/data/secret file'")
    const ran = await w.execute("echo x && command cat '/data/secret file'", { sessionId: 's' })
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
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const held = await w.execute(line, { sessionId: 's' })
    expect(held.exitCode).toBe(126)
    expect(held.refusal?.kind).toBe('pending')
    const other = await w.execute('cat /data/secret.txt', { sessionId: 's' })
    expect(other.exitCode).toBe(126)
    expect(other.refusal?.kind).toBe('pending')
    const waited = await w.execute('wait', { sessionId: 's' })
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
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(DEC.decode(first.stdout)).toBe('')
    expect(first.refusal?.kind).toBe('pending')
    await w.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW)
    const ran = await w.execute(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('x\ns ok\n')
    expect(w.decisions.list('s')).toEqual([])
  })

  it('reads two backtick pairs of one node as two occurrences', async () => {
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.execute('echo `cat /data/secret.txt` `cat /data/secret.txt`', {
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
    await w.execute('echo s > /data/secrét')
    const ran = await w.execute('echo x && command cat /data/secrét', { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('x\ns\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('runs a pair after a multibyte character on its own nod', async () => {
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.execute('echo `echo é` `cat /data/secret.txt`', { sessionId: 's' })
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
    const ran = await w.execute(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(DEC.decode(ran.stdout)).toBe('s\ns\n')
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toEqual([])
  })

  it('replays a held loop on the one answer it was given', async () => {
    const w = await ws()
    const line = 'for i in 1 2; do touch /data/mark.txt; cat /data/secret.txt; done'
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.exitCode).toBe(126)
    expect(await w.fs.readdir('/data')).not.toContain('/data/mark.txt')
    const [pending] = w.decisions.pending()
    expect(w.decisions.pending()).toHaveLength(1)
    await w.decisions.answer(pending?.id ?? '', Outcome.ALLOW)
    const again = await w.execute(line, { sessionId: 's' })
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
    const ran = await w.execute(line, { sessionId: 's' })
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
    const ran = await w.execute(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(126)
    expect(DEC.decode(ran.stderr)).toBe('cat: Permission denied\n')
    expect(await w.fs.readdir('/data')).not.toContain('/data/mark.txt')
  })

  it('runs every batch xargs hands on on one nod', async () => {
    // Each batch xargs hands on is a nested line of its own, evaluated
    // from the one xargs node, so every batch's cat stands at the same
    // place. What the first batch's gate claims is handed to the outer
    // line when the batch ends, and the second batch runs on it.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.execute("printf '/data/secret.txt /data/secret.txt' | xargs -n1 cat", {
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
    const first = await w.execute(line, { sessionId: 's' })
    expect(first.refusal?.kind).toBe('pending')
    const [pending] = w.decisions.pending()
    expect(w.decisions.pending()).toHaveLength(1)
    await w.decisions.answer(pending?.id ?? '', Outcome.ALLOW)
    const again = await w.execute(line, { sessionId: 's' })
    expect(again.exitCode).toBe(0)
    expect(DEC.decode(again.stdout)).toBe('s\ns\n')
    expect(w.decisions.list('s')).toEqual([])
  })

  it('runs every job a loop launches on one nod', async () => {
    // The loop body launches a job from one place twice (through eval,
    // whose line is a program: a `&` written directly in a loop body still
    // runs in the foreground). Each job takes a copy of the grant claimed
    // for that place, the line's end leaves the grant standing while a job
    // holds it, and the last job's end spends it.
    const asked: string[] = []
    const w = await inlineWs(answering(asked, Outcome.ALLOW))
    const ran = await w.execute(
      "for i in 1 2; do eval 'sleep 0.2 && cat /data/secret.txt >> /data/read.txt &'; done",
      { sessionId: 's' },
    )
    expect(ran.exitCode).toBe(0)
    expect(asked).toHaveLength(1)
    expect(w.decisions.list('s')).toHaveLength(1)
    const waited = await w.execute('wait', { sessionId: 's' })
    expect(waited.exitCode).toBe(0)
    expect(await w.fs.readFileText('/data/read.txt')).toBe('s\ns\n')
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
    const ran = await w.execute(line, { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    expect(asked).toHaveLength(1)
    const waited = await w.execute('wait', { sessionId: 's' })
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
    const ran = await w.execute('sleep 0.2 && echo /data/secret.txt | xargs cat &', {
      sessionId: 's',
    })
    expect(ran.exitCode).toBe(0)
    expect(asked).toEqual([])
    const waited = await w.execute('wait', { sessionId: 's' })
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
      const ran = await w.execute(line, { sessionId: 's' })
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
    const ran = await w.execute('for i in 1 2; do c; done', { sessionId: 's' })
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
    const ran = await w.execute('sleep 0.2 && c &', { sessionId: 's' })
    expect(ran.exitCode).toBe(0)
    const waited = await w.execute('wait', { sessionId: 's' })
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
    await w.execute(
      "touch /data/mark.txt && printf 'x\\n' | mapfile -t -c 1 -C 'cat /data/secret.txt'",
      {
        sessionId: 's',
      },
    )
    expect(seen).toEqual([['cat', '/data/secret.txt', '0', 'x']])
    expect(w.decisions.list('s')).toEqual([])
  })
})
