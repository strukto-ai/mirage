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

import { Channel } from '@struktoai/mirage-core/shell/console/index'
import { asyncContextIsolatesTasks } from '@struktoai/mirage-core/utils/async_context'
import { CLISpec } from '@struktoai/mirage-core/commands/cli/types'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { JobConsole, MountMode, RAMVFS, Workspace } from '@struktoai/mirage-browser'
import {
  bindMount,
  compare,
  runCase,
  type Case,
  type ExecWorkspace,
} from '../runners/typescript/execution.ts'
import substitutionScope from '../bash/cmdsub/scope.json'
import assignmentRedirect from '../bash/assign/redirect.json'
import unset from '../bash/builtin/unset.json'
import substitutionStatus from '../bash/cmdsub/status.json'
import commandFunction from '../bash/command/function.json'
import commandRun from '../bash/command/run.json'
import jobsBackground from '../bash/jobs/bg.json'
import jobsOutput from '../bash/jobs/output.json'
import nestedSyntax from '../bash/quoted/nested_subshell.json'
import quotingSyntax from '../bash/syntax/quoting.json'
import pipelineStatus from '../bash/param/pipestatus.json'
import traps from '../bash/trap/exit.json'

export interface Outcome {
  name: string
  error?: string
}

type Check = (ws: Workspace) => Promise<void>

const DEC = new TextDecoder()

function workspace(): Workspace {
  return new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
}

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function shell(
  ws: Workspace,
  command: string,
  options: Parameters<Workspace['shell']>[1] = {},
): Promise<[number, string, string]> {
  const result = await ws.shell(command, options)
  return [result.exitCode, result.stdoutText, result.stderrText]
}

async function aborted(running: Promise<unknown>): Promise<string> {
  try {
    await running
  } catch (error) {
    return error instanceof Error ? error.name : String(error)
  }
  return 'settled'
}

async function settle(ready: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5000
  while (!(await ready())) {
    if (performance.now() > deadline) throw new Error('timed out waiting for the line to start')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function battery(): [string, Check][] {
  const files = [
    traps,
    substitutionScope,
    assignmentRedirect,
    unset,
    substitutionStatus,
    commandRun,
    commandFunction,
    jobsBackground,
    jobsOutput,
    nestedSyntax,
    quotingSyntax,
    pipelineStatus,
  ]
  return files.flatMap((file) =>
    (file.cases as unknown as Case[]).map((c): [string, Check] => [
      c.id,
      async (ws) => {
        const bound = bindMount(c, '/data')
        const run = await runCase(ws as unknown as ExecWorkspace, bound)
        equal(compare(bound, run.exitCode, run.out, run.err, run.elapsed, run.checkOut), [])
      },
    ]),
  )
}

function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  return {
    wait: new Promise<void>((resolve) => {
      open = resolve
    }),
    get open() {
      return open
    },
  }
}

const CHECKS: [string, Check][] = [
  [
    'a page has no task-local async context',
    async () => {
      equal(asyncContextIsolatesTasks, false)
    },
  ],
  [
    'a suspended substitution keeps its writes off the parent',
    async (ws) => {
      let enter!: () => void, release!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      ws.registerCli(
        'stall',
        new CLISpec({
          name: 'stall',
          fn: async () => {
            enter()
            await gate
            return [null, new IOResult()]
          },
        }),
      )
      const abort = new AbortController()
      const timeout = setTimeout(() => abort.abort(), 5000)
      const running = shell(ws, 'X=parent; value=$(X=child; stall; echo "$X"); echo "$X:$value"', {
        signal: abort.signal,
      })
      try {
        await Promise.race([
          entered,
          running.then(() => {
            throw new Error('substitution finished before reaching its gate')
          }),
        ])
        equal(ws.getSession(ws.defaultSessionId).env.X, 'parent')
        release()
        equal(await running, [0, 'parent:child\n', ''])
      } finally {
        release()
        clearTimeout(timeout)
        await Promise.allSettled([running])
      }
    },
  ],
  [
    'per-call env stays with its call under concurrency',
    async (ws) => {
      const [left, right] = await Promise.all([
        shell(ws, "sleep 0.01; eval 'echo $LABEL'; echo $(echo $LABEL)", {
          env: { LABEL: 'left' },
        }),
        shell(ws, "eval 'echo $LABEL'; sleep 0.02; echo $(echo $LABEL)", {
          env: { LABEL: 'right' },
        }),
      ])
      equal(
        [left, right],
        [
          [0, 'left\nleft\n', ''],
          [0, 'right\nright\n', ''],
        ],
      )
      equal(await shell(ws, 'echo ${LABEL-unset}'), [0, 'unset\n', ''])
    },
  ],
  [
    'two sessions meet and run their own exit traps',
    async (ws) => {
      ws.createSession('peer')
      const wait = (file: string): string =>
        `for i in $(seq 500); do [ -f /data/${file} ] && break; sleep 0.01; done`
      const met = await Promise.all([
        shell(ws, `echo left > /data/meet-left; ${wait('meet-right')}; cat /data/meet-right`),
        shell(ws, `echo right > /data/meet-right; ${wait('meet-left')}; cat /data/meet-left`, {
          sessionId: 'peer',
        }),
      ])
      equal(met, [
        [0, 'right\n', ''],
        [0, 'left\n', ''],
      ])
      const trap = (file: string): string =>
        `bash -c 'trap "sleep .01; echo $LABEL > /data/${file}" EXIT; echo body:$LABEL'`
      const bodies = await Promise.all([
        shell(ws, trap('trap-left'), { env: { LABEL: 'left' } }),
        shell(ws, trap('trap-right'), { env: { LABEL: 'right' }, sessionId: 'peer' }),
      ])
      equal(bodies, [
        [0, 'body:left\n', ''],
        [0, 'body:right\n', ''],
      ])
      equal(await shell(ws, 'cat /data/trap-left /data/trap-right; trap -p'), [
        0,
        'left\nright\n',
        '',
      ])
    },
  ],
  [
    'a background evaluation keeps its own fork',
    async (ws) => {
      equal(
        await shell(
          ws,
          `X=parent; { X=child; eval 'echo "$X"'; echo "$(echo "$X")"; } & wait; echo "$X"`,
        ),
        [0, 'child\nchild\nparent\n', ''],
      )
    },
  ],
  [
    'an aborted wait leaves the background job running',
    async (ws) => {
      await shell(ws, 'sleep 30 &')
      const abort = new AbortController()
      const waiting = ws.shell('wait', { signal: abort.signal })
      abort.abort()
      equal(await aborted(waiting), 'AbortError')
      equal(ws.jobTable.get(1, ws.defaultSessionId)?.status, 'running')
    },
  ],
  [
    'closing the workspace settles a running job and its console',
    async (ws) => {
      await shell(ws, 'sleep 30 &')
      const job = ws.jobTable.get(1, ws.defaultSessionId)
      if (job === null) throw new Error('missing job')
      const finished = job.console.waitFinished()
      await ws.close()
      await finished
      equal(job.status, 'killed')
    },
  ],
  [
    'cancelling a line stops it before its next write',
    async (ws) => {
      const sink = new JobConsole()
      const abort = new AbortController()
      const running = ws.shell('echo ready; sleep 30; echo BAD > /data/cancelled', {
        sink,
        signal: abort.signal,
      })
      await settle(async () => DEC.decode(await sink.snapshot(Channel.STDOUT)) === 'ready\n')
      abort.abort()
      equal(await aborted(running), 'AbortError')
      equal((await shell(ws, 'test -e /data/cancelled'))[0], 1)
      await sink.close()
    },
  ],
  [
    'restricted sessions retain their own access facts across awaits',
    async (ws) => {
      const a = barrier(),
        b = barrier(),
        releaseA = barrier(),
        releaseB = barrier()
      ws.registerCli(
        'holda',
        new CLISpec({
          name: 'holda',
          fn: async () => {
            a.open()
            await releaseA.wait
            return [null, new IOResult()]
          },
        }),
      )
      ws.registerCli(
        'holdb',
        new CLISpec({
          name: 'holdb',
          fn: async () => {
            b.open()
            await releaseB.wait
            return [null, new IOResult()]
          },
        }),
      )
      ws.createSession('restricted', {
        profile: {
          paths: { hide: ['/data/.hidden'] },
          mounts: new Map([['/data', { mode: MountMode.READ }]]),
        },
      })
      const setup = await ws.shell('echo secret > /data/.hidden; echo public > /data/public')
      equal(setup.exitCode, 0)
      let left: ReturnType<Workspace['shell']> | undefined,
        right: ReturnType<Workspace['shell']> | undefined
      try {
        left = ws.shell(
          'umask 002; shopt -s dotglob; holda; printf "%s\\n" /data/*; mkdir /data/left; stat -c %a /data/left',
        )
        await a.wait
        right = ws.shell('umask 077; holdb; printf "%s\\n" /data/*; mkdir /data/right', {
          sessionId: 'restricted',
        })
        await b.wait
        releaseA.open()
        const l = await left
        equal(
          [l.exitCode, l.stdoutText, l.stderrText],
          [0, '/data/.hidden\n/data/public\n775\n', ''],
        )
        releaseB.open()
        const r = await right
        equal(r.stdoutText, '/data/left\n/data/public\n')
        equal(r.exitCode, 1)
        equal(r.stderrText.includes('Read-only file system'), true)
      } finally {
        releaseA.open()
        releaseB.open()
        await Promise.allSettled([left, right])
      }
    },
  ],
  [
    'concurrent workspaces record their own I/O at identical mount paths',
    async (ws) => {
      const peer = workspace()
      const enteredA = barrier(),
        enteredB = barrier(),
        releaseA = barrier(),
        releaseB = barrier()
      ws.registerCli(
        'hold',
        new CLISpec({
          name: 'hold',
          fn: async () => {
            enteredA.open()
            await releaseA.wait
            return [null, new IOResult()]
          },
        }),
      )
      peer.registerCli(
        'hold',
        new CLISpec({
          name: 'hold',
          fn: async () => {
            enteredB.open()
            await releaseB.wait
            return [null, new IOResult()]
          },
        }),
      )
      let left: ReturnType<Workspace['shell']> | undefined,
        right: ReturnType<Workspace['shell']> | undefined
      try {
        left = ws.shell('hold; echo left > /data/same; cat /data/same')
        await enteredA.wait
        right = peer.shell('hold; echo right > /data/same; cat /data/same')
        await enteredB.wait
        releaseA.open()
        equal((await left).stdoutText, 'left\n')
        releaseB.open()
        equal((await right).stdoutText, 'right\n')
        const leftOps = (await ws.observer.events()).filter((e) => e.type === 'op')
        const rightOps = (await peer.observer.events()).filter((e) => e.type === 'op')
        equal(
          leftOps.map((e) => [e.op, e.path, e.bytes]),
          [
            ['write', '/data/same', 5],
            ['read', '/data/same', 5],
          ],
        )
        equal(
          rightOps.map((e) => [e.op, e.path, e.bytes]),
          [
            ['write', '/data/same', 6],
            ['read', '/data/same', 6],
          ],
        )
      } finally {
        releaseA.open()
        releaseB.open()
        await Promise.allSettled([left, right])
        await peer.close()
      }
    },
  ],
  [
    'a foreign workspace policy never judges a suspended caller',
    async (ws) => {
      const peer = new Workspace(
        { '/data': new RAMVFS() },
        {
          mode: MountMode.WRITE,
          policies: [{ preVfs: () => ({ kind: 'deny', reason: 'peer-only refusal' }) }],
        },
      )
      const a = barrier(),
        b = barrier(),
        releaseA = barrier(),
        releaseB = barrier()
      ws.registerCli(
        'hold',
        new CLISpec({
          name: 'hold',
          fn: async () => {
            a.open()
            await releaseA.wait
            return [null, new IOResult()]
          },
        }),
      )
      peer.registerCli(
        'hold',
        new CLISpec({
          name: 'hold',
          fn: async () => {
            b.open()
            await releaseB.wait
            return [null, new IOResult()]
          },
        }),
      )
      await ws.shell('echo allowed > /data/text')
      let left: ReturnType<Workspace['shell']> | undefined,
        right: ReturnType<Workspace['shell']> | undefined
      try {
        left = ws.shell('hold; cat /data/text')
        await a.wait
        right = peer.shell('hold; echo forbidden > /data/text')
        await b.wait
        releaseA.open()
        const allowed = await left
        equal([allowed.exitCode, allowed.stdoutText, allowed.stderrText], [0, 'allowed\n', ''])
        releaseB.open()
        equal((await right).exitCode !== 0, true)
      } finally {
        releaseA.open()
        releaseB.open()
        await Promise.allSettled([left, right])
        await peer.close()
      }
    },
  ],
  ...battery(),
]

/** Run every check on a workspace of its own, recording each outcome. */
export async function runSuite(): Promise<Outcome[]> {
  const outcomes: Outcome[] = []
  for (const [name, check] of CHECKS) {
    const ws = workspace()
    try {
      await check(ws)
      outcomes.push({ name })
    } catch (error) {
      outcomes.push({ name, error: error instanceof Error ? error.message : String(error) })
    } finally {
      await ws.close()
    }
  }
  return outcomes
}
