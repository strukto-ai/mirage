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
import { Context } from '@deepseek-ai/cordis'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { Outcome, Scope } from '@struktoai/mirage-core/policy/types'
import { MountMode } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-node'
import { APPROVAL_TOOL_NAME, approvalReason, approverOf } from './approval.ts'
import type { ApprovalOutcome } from './approval.ts'
import { MirageService } from './service.ts'
import { MirageShellExecutor } from './shell.ts'

const ASK_RM = { commands: { ask: [{ reason: 'deletes are reviewed', commands: ['rm'] }] } }

interface AskedRequest {
  toolName: string
  callId: string
  reason: string
  signal?: AbortSignal
}

interface World {
  shell: MirageShellExecutor
  ws: Workspace
  asked: AskedRequest[]
}

const worlds: Workspace[] = []

/**
 * A world with one role and, optionally, an approval channel answering
 * every request the same way. The fixture is seeded through the unroled
 * default session, so the role's own rules do not refuse the setup at the
 * op door, and the shell is bound to a session carrying the role.
 */
async function world(
  role: unknown,
  outcome?: ApprovalOutcome,
  answer?: (req: AskedRequest) => Promise<ApprovalOutcome>,
): Promise<World> {
  const asked: AskedRequest[] = []
  const fixed = outcome === undefined ? null : () => Promise.resolve(outcome)
  const respond = answer ?? fixed
  const ctx = new Context()
  if (respond !== null) {
    ctx.provide('approval')
    ctx.set('approval', {
      request: (req: AskedRequest) => {
        asked.push(req)
        return respond(req)
      },
    })
  }
  await ctx
    .plugin(MirageService, {
      mounts: { '/data': [new RAMResource(), MountMode.WRITE] },
      profiles: { agent: role },
    })
    .await()
  const ws = await ctx.mirage.ready
  worlds.push(ws)
  await ws.fs.writeFile('/data/notes.txt', 'private')
  ws.createSession('agent', { profile: 'agent' })
  await ctx.plugin(MirageShellExecutor, { sessionId: 'agent' }).await()
  return { shell: ctx.shell as MirageShellExecutor, ws, asked }
}

afterEach(async () => {
  while (worlds.length > 0) await worlds.pop()?.close()
})

describe('approverOf', () => {
  it('answers null on a context with no approval service', () => {
    // A plain `ctx.approval` read would throw here rather than answer
    // undefined, which is the whole reason this goes through `ctx.get`.
    expect(approverOf(new Context())).toBeNull()
  })

  it('answers the provided approver', () => {
    const ctx = new Context()
    const approver = { request: () => Promise.resolve('rejected' as ApprovalOutcome) }
    ctx.provide('approval')
    ctx.set('approval', approver)
    expect(approverOf(ctx)).toBe(approver)
  })

  it('ignores a provided value that cannot answer a request', () => {
    const ctx = new Context()
    ctx.provide('approval')
    ctx.set('approval', { notARequester: true })
    expect(approverOf(ctx)).toBeNull()
  })
})

/** The prompt for an `rm` asked about these words. */
function said(argv: string[]): string {
  return approvalReason({
    id: 'abc',
    sessionId: 'agent',
    agentId: '',
    command: 'rm',
    argv,
    cwd: '/',
    paths: [],
    reason: 'deletes are reviewed',
    rule: { reason: 'deletes are reviewed' },
    outcome: null,
    scope: Scope.ONCE,
    note: '',
  })
}

describe('approvalReason', () => {
  it('quotes the line beside the operator sentence', () => {
    const reason = approvalReason({
      id: 'abc',
      sessionId: 'agent',
      agentId: '',
      command: 'rm',
      argv: ['-rf', '/data/notes.txt'],
      cwd: '/',
      paths: [],
      reason: 'deletes are reviewed',
      rule: { reason: 'deletes are reviewed' },
      outcome: null,
      scope: Scope.ONCE,
      note: '',
    })
    // The rule's sentence alone names nothing being deleted.
    expect(reason).toBe('deletes are reviewed: rm -rf /data/notes.txt')
  })

  it('keeps the boundary of a word a shell would read as two', () => {
    // Joined raw this read `rm -- quarterly report`, naming two
    // operands where the run has one file.
    expect(said(['--', 'quarterly report'])).toBe("deletes are reviewed: rm -- 'quarterly report'")
  })

  it('renders a word that would forge a line break in the prompt', () => {
    expect(said(['/data/a\nrm -rf /'])).toBe("deletes are reviewed: rm '/data/a'$'\\n''rm -rf /'")
  })

  it('leaves ordinary words bare', () => {
    // The quoting is GNU's diagnostic rendering, so the common prompt
    // is not dressed up into something a human has to decode.
    expect(said(['-rf', '/data/notes.txt'])).toBe('deletes are reviewed: rm -rf /data/notes.txt')
  })
})

describe('an asked line with an approval channel', () => {
  it('runs the line when the human allows it once', async () => {
    const { shell, ws, asked } = await world(ASK_RM, 'allowed-once')
    const run = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(run.exitCode).toBe(0)
    expect(run.stderr.text).toBe('')
    expect(await ws.fs.exists('/data/notes.txt')).toBe(false)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.toolName).toBe(APPROVAL_TOOL_NAME)
    expect(asked[0]?.reason).toBe('deletes are reviewed: rm /data/notes.txt')
  })

  it('spends an inline refusal on that line, so the next line asks afresh', async () => {
    const { shell, asked } = await world(ASK_RM, 'rejected')
    const first = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(first.exitCode).toBe(126)
    expect(asked).toHaveLength(1)
    // The inline refusal answered the first line and was spent by it, so the
    // next identical line is a new question rather than a second refusal
    // borrowed from the first question.
    const retry = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(retry.exitCode).toBe(126)
    expect(asked).toHaveLength(2)
    // Both questions were the same line, so both quote one identity.
    expect(asked[0]?.callId).toBe(asked[1]?.callId)
  })

  it('grants once and never for the session, so the next line asks again', async () => {
    const { shell, ws, asked } = await world(ASK_RM, 'allowed-once')
    await ws.fs.writeFile('/data/second.txt', 'also private')
    expect((await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))).exitCode).toBe(0)
    expect((await shell.run(shell.resolve({ command: 'rm /data/second.txt' }))).exitCode).toBe(0)
    // One nod covered one line; the second line raised its own question.
    expect(asked).toHaveLength(2)
  })

  it.each([
    ['rejected', 'an explicit refusal'],
    ['cancelled', 'a prompt the human dismissed'],
    ['unavailable', 'a channel that could not answer'],
  ] as const)('refuses the line on %s (%s)', async (outcome, _why) => {
    const { shell, ws } = await world(ASK_RM, outcome)
    const run = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(run.exitCode).toBe(126)
    expect(run.stderr.text).toBe('rm: Permission denied\n')
    expect(await ws.fs.exists('/data/notes.txt')).toBe(true)
    // A refusal is a refusal however it was reached: no pending question
    // is left behind for a host to answer instead.
    expect(ws.decisions.pending('agent')).toHaveLength(0)
  })

  it('leaves an unasked line alone', async () => {
    const { shell, asked } = await world(ASK_RM, 'rejected')
    const run = await shell.run(shell.resolve({ command: 'cat /data/notes.txt' }))
    expect(run.exitCode).toBe(0)
    expect(run.stdout.text).toBe('private')
    expect(asked).toEqual([])
  })
})

describe('an asked line with no approval channel', () => {
  it('stays pending in the ledger rather than being rewritten as a deny', async () => {
    const { shell, ws } = await world(ASK_RM)
    const run = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(run.exitCode).toBe(126)
    // The operator's document said `ask`; the refusal says so too, and
    // names the approval a host can grant.
    expect(run.stderr.text).toBe('rm: Permission denied\n')
    expect(await ws.fs.exists('/data/notes.txt')).toBe(true)
    const pending = ws.decisions.pending('agent')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.command).toBe('rm')
    expect(pending[0]?.reason).toBe('deletes are reviewed')
  })

  it('passes the retry once a host answers the pending record out of band', async () => {
    const { shell, ws } = await world(ASK_RM)
    const first = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(first.exitCode).toBe(126)
    const waiting = ws.decisions.pending('agent')[0]
    expect(waiting).toBeDefined()
    await ws.decisions.answer(waiting?.id ?? '', Outcome.ALLOW, Scope.ONCE)
    const retry = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(retry.exitCode).toBe(0)
    expect(await ws.fs.exists('/data/notes.txt')).toBe(false)
  })

  it('refuses the retry when the host answers no', async () => {
    const { shell, ws } = await world(ASK_RM)
    await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    const waiting = ws.decisions.pending('agent')[0]
    await ws.decisions.answer(waiting?.id ?? '', Outcome.DENY, Scope.ONCE)
    const retry = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(retry.exitCode).toBe(126)
    expect(retry.stderr.text).toBe('rm: Permission denied\n')
    expect(retry.sandbox?.denied).toBe(true)
    expect(await ws.fs.exists('/data/notes.txt')).toBe(true)
  })
})

describe('the sandbox facts a refused run reports', () => {
  it('marks a whole-line policy deny as denied', async () => {
    const { shell } = await world({
      commands: { deny: [{ reason: 'no removes', commands: ['rm'] }] },
    })
    const run = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(run.exitCode).toBe(126)
    expect(run.sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
  })

  it('marks a policy deny under workspace-write, which no mode narrowing would', async () => {
    // The read-only narrowing is this executor's own and only applies to a
    // read-only call. A role's rules are not, so the flag has to be set
    // for a call carrying the widest mode there is.
    const { shell } = await world({
      commands: { deny: [{ reason: 'no removes', commands: ['rm'] }] },
    })
    const run = await shell.run(
      shell.resolve({
        command: 'rm /data/notes.txt',
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: '/host' },
      }),
    )
    expect(run.sandbox?.denied).toBe(true)
  })

  it('marks an unanswered ask as denied too', async () => {
    const { shell } = await world(ASK_RM)
    const run = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(run.sandbox?.denied).toBe(true)
  })

  it('leaves an allowed line unmarked', async () => {
    const { shell } = await world(ASK_RM, 'allowed-once')
    const run = await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))
    expect(run.sandbox?.denied).toBe(false)
  })

  it('does not mark an ordinary command failure', async () => {
    const { shell } = await world(ASK_RM, 'allowed-once')
    const run = await shell.run(shell.resolve({ command: 'cat /data/no-such-file.txt' }))
    expect(run.exitCode).not.toBe(0)
    expect(run.sandbox?.denied).toBe(false)
  })
})

/** A channel that takes the request and never comes back with an answer. */
function neverAnswers(): Promise<ApprovalOutcome> {
  return new Promise<ApprovalOutcome>(() => {
    // Deliberately never settled: the human is still looking at it.
  })
}

describe('an ask that outlives the run that raised it', () => {
  it('reports the timeout instead of waiting on the human forever', async () => {
    const { shell, ws } = await world(ASK_RM, undefined, neverAnswers)
    const run = await shell.run(shell.resolve({ command: 'rm /data/notes.txt', timeoutMs: 200 }))
    // Without a bound on the wait this call never returned at all: the
    // run sat inside the approval request, deaf to its own deadline.
    expect(run.timedOut).toBe(true)
    expect(run.exitCode).toBeNull()
    expect(run.signal).toBe('SIGTERM')
    expect(await ws.fs.exists('/data/notes.txt')).toBe(true)
  })

  it('reports the timeout for a compound line, judged before any of it runs', async () => {
    const { shell, ws } = await world(ASK_RM, undefined, neverAnswers)
    // A line with more than one command is held by the prejudge pass,
    // which asks its own questions. That pass took no signal, so this
    // shape ignored the deadline even after the single-command one
    // stopped doing so.
    const run = await shell.run(
      shell.resolve({ command: 'rm /data/notes.txt; echo done', timeoutMs: 200 }),
    )
    expect(run.timedOut).toBe(true)
    expect(run.exitCode).toBeNull()
    expect(await ws.fs.exists('/data/notes.txt')).toBe(true)
  })

  it('hands the run signal to the channel, live, so its prompt can be dismissed', async () => {
    const { shell, asked } = await world(ASK_RM, undefined, (req) => {
      expect(req.signal?.aborted).toBe(false)
      return Promise.resolve('allowed-once')
    })
    expect((await shell.run(shell.resolve({ command: 'rm /data/notes.txt' }))).exitCode).toBe(0)
    const signal = asked[0]?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('drops a yes that arrives after the kill rather than banking it', async () => {
    const { shell, ws } = await world(ASK_RM, undefined, () => {
      return new Promise((resolve) =>
        setTimeout(() => {
          resolve('allowed-once')
        }, 400),
      )
    })
    const killed = await shell.run(shell.resolve({ command: 'rm /data/notes.txt', timeoutMs: 150 }))
    expect(killed.timedOut).toBe(true)
    await new Promise((settle) => setTimeout(settle, 500))
    // The human said yes to a line that no longer existed. Banking that
    // as a spent-once grant would hand it to the next identical line
    // with nobody asked, so the question stays open instead.
    expect(await ws.fs.exists('/data/notes.txt')).toBe(true)
    expect(ws.decisions.pending('agent')).toHaveLength(1)
    expect(ws.decisions.list('agent')[0]?.outcome).toBeNull()
  })
})

describe('a refusal the line redirected away from stderr', () => {
  it('is still reported as denied when 2>&1 puts it on stdout', async () => {
    const { shell } = await world({
      commands: { deny: [{ reason: 'no removes', commands: ['rm'] }] },
    })
    const run = await shell.run(shell.resolve({ command: 'rm /data/notes.txt 2>&1' }))
    expect(run.exitCode).toBe(126)
    expect(run.stderr.text).toBe('')
    expect(run.stdout.text).toBe('rm: Permission denied\n')
    // The ruling rides the result, not the streams, so where the line
    // sent its diagnostics changes nothing.
    expect(run.sandbox?.denied).toBe(true)
  })

  it('does not read the same words as a refusal when a line prints them as data', async () => {
    const { shell } = await world(ASK_RM, 'allowed-once')
    const run = await shell.run(shell.resolve({ command: "echo 'rm: Permission denied'" }))
    expect(run.exitCode).toBe(0)
    expect(run.stdout.text).toBe('rm: Permission denied\n')
    // The words are data; only the result's own record is a ruling.
    expect(run.sandbox?.denied).toBe(false)
  })
})
