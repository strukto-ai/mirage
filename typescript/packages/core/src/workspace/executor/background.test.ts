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

import { describe, expect, it, vi } from 'vitest'
import { stderrStr, stdoutStr } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { WorkspaceHeldError } from '../../execution/errors.ts'
import { JobTable } from '../../execution/job/index.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { RAMWorkspaceStateStore } from '../store/ram.ts'
import { Workspace } from '../workspace/workspace.ts'
import { logger } from './background.ts'

function buildWs(): Workspace {
  return new Workspace({ '/m': [new RAMVFS(), MountMode.WRITE] }, { mode: MountMode.WRITE })
}

/** A workspace on a state store another workspace shares. */
function sharing(store: RAMWorkspaceStateStore): Workspace {
  return new Workspace(
    { '/m': [new RAMVFS(), MountMode.WRITE] },
    { mode: MountMode.WRITE, workspaceId: 'shared', sessionId: 's', store },
  )
}

// Runners begin in the order they were started: a job begins before the
// substitution after it in its line, and before the next line, so each
// reads what the job's redirect wrote.
it.each([
  [['echo hi > /m/a & echo "$(cat /m/a)"; wait']],
  [['echo hi > /m/a &', 'cat /m/a; wait']],
])('begins a job before what its line runs next: %j', async (lines) => {
  const ws = buildWs()
  const results = []
  for (const line of lines) results.push(await ws.shell(line))
  const result = results.at(-1)
  expect([result?.stdoutText, result?.stderrText]).toEqual(['hi\n', ''])
  await ws.close()
})

const BODY_SHAPES = [
  'for i in 1; do false & done',
  'for ((k=0;k<1;k++)); do false & done',
  'n=0; while [ $n -lt 1 ]; do false & n=$((n+1)); done',
  'n=0; until [ $n -ge 1 ]; do false & n=$((n+1)); done',
  'if true; then false & fi',
  'if false; then :; elif true; then false & fi',
  'if false; then :; else false & fi',
  'case x in x) false & ;; esac',
  '{ false & }',
  'f() { false & }; f',
]

describe('& inside a compound body', () => {
  it.each(BODY_SHAPES)('launches a job with launch status 0: %s', async (line) => {
    const ws = buildWs()
    const io = await ws.shell(`${line}; echo rc=$?`)
    expect(stdoutStr(io)).toBe('rc=0\n')
    const job = ws.jobTable.get(1, ws.sessionManager.defaultId)
    expect(job?.command).toBe('false')
    await ws.jobTable.wait(1, ws.sessionManager.defaultId)
    expect(job?.exitCode).toBe(1)
  })

  it('leaves loop-body jobs running when the loop ends', async () => {
    const ws = buildWs()
    const io = await ws.shell('for i in 1 2; do sleep 0.3 & done; jobs')
    expect(stdoutStr(io)).toBe(
      '[1]-  Running                 sleep 0.3 &\n[2]+  Running                 sleep 0.3 &\n',
    )
    await ws.shell('wait')
    expect(stdoutStr(await ws.shell('jobs'))).toBe('')
  })

  it.each([
    [1, 2],
    [2, 1],
  ])(
    'loop-body jobs write after the foreground line in completion order %i, %i',
    async (first, second) => {
      const vfs = new RAMVFS()
      const ws = new Workspace({ '/m': [vfs, MountMode.WRITE] }, { mode: MountMode.WRITE })
      const releases = new Map<string, () => void>()
      const gates = new Map(
        ['1', '2'].map((id) => [
          id,
          new Promise<void>((resolve) => {
            releases.set(id, resolve)
          }),
        ]),
      )
      await ws.shell('touch /m/1 /m/2')
      const read = vi.spyOn(vfs, 'read').mockImplementation(async (path) => {
        await gates.get(path.vfsPath)
        return new Uint8Array()
      })
      try {
        const io = await ws.shell('for i in 1 2; do { cat /m/$i; echo $i; } & done; echo launched')
        expect(stdoutStr(io)).toBe('launched\n')
        for (const id of [first, second]) {
          releases.get(String(id))?.()
          await ws.jobTable.wait(id, ws.sessionManager.defaultId)
        }
        expect(stdoutStr(await ws.shell('wait'))).toBe(`${String(first)}\n${String(second)}\n`)
      } finally {
        for (const release of releases.values()) release()
        await ws.close()
        read.mockRestore()
      }
    },
  )

  it('$! names each loop-body job', async () => {
    const ws = buildWs()
    const io = await ws.shell('for i in 1 2; do sleep 0.1 & echo $!; done; wait')
    const pids = stdoutStr(io).trim().split('\n').map(Number)
    expect(pids).toHaveLength(2)
    expect(pids[1]).toBeGreaterThan(pids[0] ?? 0)
  })

  it('errexit does not trip on a body launch', async () => {
    const ws = buildWs()
    const io = await ws.shell('set -e; for i in 1; do false & done; echo ok; wait')
    expect(stdoutStr(io)).toBe('ok\n')
  })
})

// A job a job starts follows its parent's kill; it lets go once it ends,
// so a long-lived job keeps nothing of the jobs it started.
describe('a job inside a job', () => {
  it('stops following its parent once it ends', async () => {
    const added = vi.spyOn(EventTarget.prototype, 'addEventListener')
    const removed = vi.spyOn(EventTarget.prototype, 'removeEventListener')
    const ws = buildWs()
    try {
      await ws.shell('{ true & wait $!; true & wait $!; } & wait')
      const follows = added.mock.calls
        .map(([, listener]) => listener)
        .filter((listener) => typeof listener === 'function' && listener.name === 'follow')
      expect(follows).toHaveLength(2)
      for (const listener of follows) {
        expect(removed.mock.calls.some(([, gone]) => gone === listener)).toBe(true)
      }
    } finally {
      added.mockRestore()
      removed.mockRestore()
      await ws.close()
    }
  })

  it('is killed with the job past the job between them', async () => {
    const ws = buildWs()
    try {
      await ws.shell('{ { sleep 30 & } & wait $!; echo > /m/ready; sleep 30; } &')
      await vi.waitFor(
        async () => {
          expect((await ws.shell('test -e /m/ready')).exitCode).toBe(0)
        },
        { timeout: 5000, interval: 20 },
      )
      await ws.shell('kill %1')
      await vi.waitFor(
        () => {
          expect(ws.processTable.live()).toEqual([])
        },
        { timeout: 5000, interval: 20 },
      )
    } finally {
      await ws.close()
    }
  })
})

describe('background conditions and function scope', () => {
  it.each<[string, string, number]>([
    ['if false & then echo yes; else echo no; fi; wait "$!"', 'yes\n', 1],
    ['if false; then echo no; elif false & then echo yes; fi; wait "$!"', 'yes\n', 1],
    ['while false & do echo yes; break; done; wait "$!"', 'yes\n', 1],
    ['until false & do echo no; break; done; echo yes; wait "$!"', 'yes\n', 1],
    [
      'f() { { sleep 0.05; printf "%s:%s:%s\\n" "$1" "$#" "$*"; } & }; f first second; wait',
      'first:2:first second\n',
      0,
    ],
    [
      'f() { { sleep 0.05; printf "%s:%s\\n" "$1" "$#"; } & shift; }; f first second; wait',
      'first:2\n',
      0,
    ],
    [
      'f() { { shift; sleep 0.05; printf "bg:%s:%s\\n" "$1" "$#"; } & sleep 0.1; printf "fg:%s:%s\\n" "$1" "$#"; wait; }; f first second',
      'bg:second:1\nfg:first:2\n',
      0,
    ],
    ['f() { return 7 & j=$!; wait "$j"; }; f', '', 7],
    ['f() { { sleep 0.05; return 9; } & }; f; wait "$!"', '', 9],
    ['f() { false; return & j=$!; wait "$j"; }; f', '', 1],
  ])('%s', async (line, expected, code) => {
    const ws = buildWs()
    try {
      const result = await ws.shell(line)
      expect(stdoutStr(result)).toBe(expected)
      expect(stderrStr(result)).toBe('')
      expect(result.exitCode).toBe(code)
    } finally {
      await ws.close()
    }
  })
})

describe('jobs are scoped to the session that launched them', () => {
  it('another session sees no job and cannot wait on it', async () => {
    const ws = buildWs()
    ws.createSession('a')
    ws.createSession('b')
    try {
      await ws.shell('sleep 30 &', { sessionId: 'a' })
      expect(stdoutStr(await ws.shell('jobs', { sessionId: 'b' }))).toBe('')
      expect(stdoutStr(await ws.shell('jobs', { sessionId: 'a' }))).toContain('[1]')
      const io = await ws.shell('wait %1', { sessionId: 'b' })
      expect(io.exitCode).toBe(127)
      expect(stderrStr(io)).toContain('no such job')
      expect(stdoutStr(await ws.shell('ps', { sessionId: 'b' }))).not.toContain('sleep 30')
      expect((await ws.shell('kill %1', { sessionId: 'a' })).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('closing a session purges its jobs', async () => {
    const ws = buildWs()
    ws.createSession('a')
    try {
      await ws.shell('sleep 30 &', { sessionId: 'a' })
      await ws.shell('sleep 30 &', { sessionId: 'a' })
      const old = ws.jobTable.get(2, 'a')
      expect(old).not.toBeNull()
      await ws.closeSession('a')
      expect(old?.signal).not.toBeNull()
      expect(ws.jobTable.listJobs('a')).toEqual([])
      // A session reusing the id starts from one and inherits nothing.
      ws.createSession('a')
      expect(stdoutStr(await ws.shell('jobs', { sessionId: 'a' }))).toBe('')
      expect(
        Number(stdoutStr(await ws.shell('sleep 30 & echo $!', { sessionId: 'a' }))),
      ).toBeGreaterThan(old?.process?.record.id.pid ?? 0)
      expect(ws.jobTable.get(1, 'a')).not.toBeNull()
      const io = await ws.shell('wait %2', { sessionId: 'a' })
      expect(io.exitCode).toBe(127)
      expect(stderrStr(io)).toContain('no such job')
    } finally {
      await ws.close()
    }
  })

  it("closing the other sessions keeps the default one's jobs", async () => {
    const ws = buildWs()
    ws.createSession('a')
    ws.createSession('b')
    try {
      await ws.shell('sleep 30 &')
      await ws.shell('sleep 30 &', { sessionId: 'a' })
      await ws.shell('sleep 30 &', { sessionId: 'b' })
      await ws.closeSession('a')
      await ws.closeSession('b')
      expect(ws.jobTable.listJobs('a')).toEqual([])
      expect(ws.jobTable.listJobs('b')).toEqual([])
      const kept = ws.jobTable.get(1, ws.sessionManager.defaultId)
      expect(kept?.state).toBe('running')
    } finally {
      await ws.close()
    }
  })

  it('each session numbers its jobs from one', async () => {
    const ws = buildWs()
    ws.createSession('a')
    ws.createSession('b')
    try {
      const firstA = await ws.shell('sleep 30 & echo $!', { sessionId: 'a' })
      const firstB = await ws.shell('sleep 30 & echo $!', { sessionId: 'b' })
      const secondA = await ws.shell('sleep 30 & echo $!', { sessionId: 'a' })
      expect(new Set([stdoutStr(firstA), stdoutStr(firstB), stdoutStr(secondA)]).size).toBe(3)
      expect(ws.jobTable.listJobs('a').map((j) => j.id)).toEqual([1, 2])
      expect(ws.jobTable.listJobs('b').map((j) => j.id)).toEqual([1])
    } finally {
      await ws.close()
    }
  })
})

describe('job builtins honor the process profile', () => {
  it('a session at its process cap cannot fork', async () => {
    const ws = buildWs()
    ws.createSession('capped', { profile: { processes: { max: 2 } } })
    const refusal = 'bash: fork: Resource temporarily unavailable\n'
    const run = async (line: string): Promise<[string, string, number]> => {
      const io = await ws.shell(line, { sessionId: 'capped' })
      return [stdoutStr(io), new TextDecoder().decode(io.stderr), io.exitCode]
    }
    try {
      expect(await run('(sleep 30 & echo in); echo sub=$?')).toEqual(['sub=254\n', refusal, 0])
      expect(await run('sleep 30 & echo one')).toEqual(['one\n', '', 0])
      for (const line of ['(echo sub); echo no', 'echo x | cat; echo no', 'sleep 30 & echo no'])
        expect(await run(line)).toEqual(['', refusal, 254])
      expect(await run('echo $?')).toEqual(['254\n', '', 0])
      expect(await run('kill %1')).toEqual(['', '', 0])
      await ws.processTable.drain()
      expect(await run('(echo sub)')).toEqual(['sub\n', '', 0])
    } finally {
      await ws.close()
    }
  })

  it('a runaway loop stops at the process cap', async () => {
    const ws = buildWs()
    ws.createSession('capped', { profile: { processes: { max: 3 } } })
    try {
      const io = await ws.shell('n=0; while true; do sleep 30 & n=$((n+1)); done; echo no', {
        sessionId: 'capped',
      })
      expect(io.exitCode).toBe(254)
      expect(stdoutStr(await ws.shell('echo $n; jobs', { sessionId: 'capped' }))).toBe(
        '2\n[1]-  Running                 sleep 30 &\n[2]+  Running                 sleep 30 &\n',
      )
    } finally {
      await ws.close()
    }
  })
})

// A job is one program only when bash would run it as the program itself:
// `exec` and `command` run their word in place; a function, `eval`, a
// lookup, an escaped or expanded name, or a word that runs commands of its
// own keeps a shell in between.
describe('a job that is one program', () => {
  it.each([
    ['prog', true],
    ['exec prog', true],
    ['command -p prog', true],
    ['f() { prog; }; f', false],
    ['eval prog', false],
    ['command -v prog', false],
    ['command e\\val prog', false],
    ['prog $(echo 5)', false],
    ['c=prog; $c', false],
    ['{ prog; }', false],
  ] as const)('%s is one: %s', async (line, simple) => {
    const ws = buildWs()
    try {
      await ws.shell(`${line} &`)
      expect(ws.jobTable.get(1, ws.sessionManager.defaultId)?.simple).toBe(simple)
    } finally {
      await ws.close()
    }
  })
})

// One daemon runs a workspace's lines at a time: a line on another daemon's
// workspace is refused, naming the daemon that holds the lease, and listed as
// ended with why after the holder's lines, while that daemon lists, kills and
// waits on the jobs through the store.
it('another daemon reaches a job but runs no line', async () => {
  const store = new RAMWorkspaceStateStore()
  const a = sharing(store)
  const b = sharing(store)
  try {
    expect((await a.shell('sleep 30 &', { sessionId: 's' })).exitCode).toBe(0)
    const refused = await b.shell('jobs', { sessionId: 's' }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(WorkspaceHeldError)
    expect((refused as WorkspaceHeldError).holder).toBe(a.jobTable.daemon)
    const [ran, line] = await b.lines()
    expect(ran?.command).toBe('sleep 30 &')
    expect([line?.command, line?.state, line?.exit]).toEqual(['jobs', 'exited', null])
    expect(line?.error).toMatch(/^WorkspaceHeldError: /)
    await b.jobTable.sync('s')
    const [seen] = b.jobTable.listJobs('s')
    expect([seen?.id, seen?.command, seen?.state]).toEqual([1, 'sleep 30', 'running'])
    expect(await b.jobTable.kill(1, 's', 15)).toBe(true)
    expect((await b.jobTable.wait(1, 's')).exitCode).toBe(143)
    const job = a.jobTable.get(1, 's')
    expect(job?.process).not.toBeNull()
    await job?.process?.join()
    expect([job?.signal, job?.exitCode]).toEqual([15, 143])
  } finally {
    await a.close()
    await b.close()
  }
})

// Once the daemon holding the lease closes the workspace, another one runs
// its lines, numbering its pids past every pid the first gave out.
it('a workspace runs on another daemon once its own closes', async () => {
  const store = new RAMWorkspaceStateStore()
  const a = sharing(store)
  const b = sharing(store)
  try {
    const first = stdoutStr(await a.shell('true & echo $!', { sessionId: 's' }))
    await a.close()
    const second = stdoutStr(await b.shell('true & echo $!', { sessionId: 's' }))
    expect(Number(second)).toBeGreaterThan(Number(first))
  } finally {
    await b.close()
  }
})

it.each([
  ['never runs', 'exec 3</m/f; { cat <&3; } & exec 3<&-; wait', true],
  ['ran', 'exec 3</m/f; { cat <&3 >/dev/null; } & wait; exec 3<&-', false],
])('a job whose runner %s lets go of its readers', async (_, line, skip) => {
  const releasing = vi.spyOn(AsyncLineIterator.prototype, 'release')
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const submit = JobTable.prototype.submit
  // An abort before the runner begins is the state a kill from a
  // concurrent line reaches: settle skips runBg.
  const submitting = vi.spyOn(JobTable.prototype, 'submit').mockImplementation(function (
    this: JobTable,
    init,
  ) {
    if (skip) init.abort.abort()
    return submit.call(this, init)
  })
  const ws = buildWs()
  try {
    await ws.shell("printf 'x\\n' >/m/f")
    await ws.shell(line)
    await vi.waitFor(() => {
      const state = [...new Set(releasing.mock.contexts)].map((r) => {
        const held = r as { holders: number; exhausted: boolean }
        return [held.holders, held.exhausted]
      })
      expect(state).toEqual([[0, true]])
    })
  } finally {
    releasing.mockRestore()
    submitting.mockRestore()
    await ws.close()
  }
})

it('logs a never-run job whose hold fails to drop and drops the others', async () => {
  const debug = vi.fn()
  logger.debug = debug
  const unhold = vi
    .spyOn(AsyncLineIterator.prototype, 'unhold')
    .mockRejectedValueOnce(new Error('unhold failed'))
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const submit = JobTable.prototype.submit
  const submitting = vi.spyOn(JobTable.prototype, 'submit').mockImplementation(function (
    this: JobTable,
    init,
  ) {
    init.abort.abort()
    return submit.call(this, init)
  })
  const ws = buildWs()
  try {
    await ws.shell("printf 'x\\n' >/m/f")
    await ws.shell('exec 3</m/f 4</m/f; { cat <&3; } & exec 3<&- 4<&-; wait')
    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith(
        'job: dropping its holds on readers failed: Error: unhold failed',
      )
    })
    const [failed, ...rest] = unhold.mock.contexts as { holders: number }[]
    expect(rest.length).toBeGreaterThan(0)
    expect([failed?.holders, ...rest.map((lines) => lines.holders)]).toEqual([
      1,
      ...rest.map(() => 0),
    ])
  } finally {
    delete logger.debug
    unhold.mockRestore()
    submitting.mockRestore()
    await ws.close()
  }
})

it("releases a never-run job's readers before its mounts close", async () => {
  const order: string[] = []
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const unhold = AsyncLineIterator.prototype.unhold
  const slow = vi.spyOn(AsyncLineIterator.prototype, 'unhold').mockImplementation(async function (
    this: AsyncLineIterator,
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    await unhold.call(this)
    order.push('released')
  })
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const submit = JobTable.prototype.submit
  const submitting = vi.spyOn(JobTable.prototype, 'submit').mockImplementation(function (
    this: JobTable,
    init,
  ) {
    init.abort.abort()
    return submit.call(this, init)
  })
  const vfs = new RAMVFS()
  const close = vfs.close.bind(vfs)
  vi.spyOn(vfs, 'close').mockImplementation(async () => {
    order.push('closed')
    await close()
  })
  const ws = new Workspace({ '/m': [vfs, MountMode.WRITE] }, { mode: MountMode.WRITE })
  try {
    await ws.shell("printf 'x\\n' >/m/f")
    await ws.shell('exec 3</m/f; { cat <&3; } & exec 3<&-')
  } finally {
    await ws.close()
    slow.mockRestore()
    submitting.mockRestore()
  }
  expect(order).toContain('released')
  expect(order.at(-1)).toBe('closed')
})

describe('a job as bash runs it', () => {
  const build = (): Workspace =>
    new Workspace({ '/m': [new RAMVFS(), MountMode.WRITE] }, { mode: MountMode.WRITE })

  it('is its stages when it is a pipeline', async () => {
    const ws = build()
    try {
      const said = await ws.shell(
        'sleep 30 | cat & echo $!; echo $$; ps -o pid=,ppid=,cmd=; jobs -l; jobs -p',
      )
      const [last = '', shell = '', ...rest] = stdoutStr(said).trimEnd().split('\n')
      const first = String(Number(last) - 1)
      const rows = rest.slice(0, 4).map((line) => line.trim().split(/\s+/))
      expect(rows.slice(1, 3)).toEqual([
        [first, shell, 'sleep', '30'],
        [last, shell, 'cat'],
      ])
      expect(rest.slice(4)).toEqual([
        `[1]+ ${first} Running                 sleep 30`,
        `     ${last}                       | cat &`,
        first,
      ])
      expect(stdoutStr(await ws.shell(`kill ${last}; wait ${last}; echo $?; jobs`))).toBe('143\n')
    } finally {
      await ws.close()
    }
  })

  it('answers for the pipeline under pipefail when its last stage is waited for', async () => {
    const ws = build()
    try {
      const io = await ws.shell("set -o pipefail; sh -c 'exit 4' | sleep 0.1 & wait $!; echo $?")
      expect(stdoutStr(io)).toBe('4\n')
    } finally {
      await ws.close()
    }
  })

  it('answers a second wait for a pid with its status', async () => {
    const ws = build()
    try {
      const io = await ws.shell("sh -c 'exit 3' & p=$!; wait $p; echo $?; wait $p; echo $?")
      expect(stdoutStr(io)).toBe('3\n3\n')
    } finally {
      await ws.close()
    }
  })

  it('names jobs by the specs bash takes', async () => {
    const ws = build()
    try {
      await ws.shell('sleep 30 & sleep 31 &')
      const one = '[1]-  Running                 sleep 30 &\n'
      const two = '[2]+  Running                 sleep 31 &\n'
      expect(
        stdoutStr(await ws.shell("jobs %%; jobs %+; jobs %; jobs %-; jobs '%sleep 30'; jobs %?31")),
      ).toBe(two.repeat(3) + one.repeat(2) + two)
      const refused = await ws.shell('jobs %sleep; echo $?; kill %nope; echo $?')
      expect(stdoutStr(refused)).toBe('1\n1\n')
      expect(new TextDecoder().decode(refused.stderr)).toBe(
        'bash: line 1: jobs: sleep: ambiguous job spec\n' +
          'bash: line 1: jobs: %sleep: no such job\n' +
          'bash: line 1: kill: %nope: no such job\n',
      )
      expect(stdoutStr(await ws.shell('kill %?31 %-; wait; echo $?; jobs'))).toBe(
        '0\n[2]   Terminated              sleep 31\n',
      )
    } finally {
      await ws.close()
    }
  })

  it('marks what jobs lists, and jobs -n shows what it has not', async () => {
    const ws = build()
    try {
      expect(stdoutStr(await ws.shell('sleep 30 & true & sleep 0.2; jobs; jobs -n'))).toBe(
        '[1]-  Running                 sleep 30 &\n[2]+  Done                    true\n',
      )
    } finally {
      await ws.shell('kill %1')
      await ws.close()
    }
  })

  it('is its stages when its pipeline is redirected', async () => {
    const ws = build()
    try {
      expect(stdoutStr(await ws.shell('sleep 30 | cat > /m/out & jobs -l | wc -l'))).toBe('2\n')
    } finally {
      await ws.shell('kill %1')
      await ws.close()
    }
  })

  it('holds a TERM while stopped, until it goes on', async () => {
    const ws = build()
    try {
      const said = await ws.shell(
        'sleep 30 & kill -STOP %1; kill %1; ps -o stat= -p $!; jobs; kill -CONT %1; wait %1; echo $?',
      )
      expect(stdoutStr(said)).toBe('T\n[1]+  Running                 sleep 30 &\n143\n')
    } finally {
      await ws.close()
    }
  })

  it('moves no bytes while its pipeline is stopped', async () => {
    const ws = build()
    try {
      const said = await ws.shell(
        'seq 1 300000 | cat > /m/out & kill -STOP %1; sleep 0.3; jobs; kill -CONT %1; wait %1; echo $?; wc -l < /m/out',
      )
      expect(stdoutStr(said)).toBe(
        '[1]+  Running                 seq 1 300000 | cat > /m/out &\n0\n300000\n',
      )
    } finally {
      await ws.close()
    }
  })

  it('sees the shell that started it as $PPID', async () => {
    const ws = build()
    try {
      const said = await ws.shell("echo $PPID; (echo $PPID); echo $$; bash -c 'echo $PPID'")
      const [top, sub, shell, nested] = stdoutStr(said).trim().split('\n')
      expect([top, sub, nested]).toEqual(['0', '0', shell])
      const refused = await ws.shell('PPID=5')
      expect(new TextDecoder().decode(refused.stderr)).toBe(
        'bash: line 1: PPID: readonly variable\n',
      )
    } finally {
      await ws.close()
    }
  })
})
