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

import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { Channel } from '@struktoai/mirage-core/shell/console/index'
import { asyncContextIsolatesTasks } from '@struktoai/mirage-core/utils/async_context'
import { CLI, CLIHandler } from '@struktoai/mirage-core/commands/cli/types'
import { CommandSpec } from '@struktoai/mirage-core/commands/spec/types'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { DiffRequest } from '@struktoai/mirage-core/rs/diff_worker'
import { ICONV_MULTIBYTE_DIGESTS, iconvMultibyteDigests } from '@struktoai/mirage-core/test-utils'
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
import processStreams from '../bash/procsub/stream.json'
import rgShared from '../unix/rg/shared_engine.json'
import diffShared from '../unix/diff/shared_engine.json'
import printfBasic from '../bash/printf/basic.json'
import printfAssignments from '../bash/printf/vflag.json'
import printfShared from '../bash/printf/shared.json'
import printfOptions from '../unix/printf/unknown_option.json'

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
    processStreams,
    rgShared,
    diffShared,
    printfBasic,
    printfAssignments,
    printfShared,
    printfOptions,
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

const CHECKS: [string, Check][] = [
  [
    'diff workers are reused, expire while idle and belong to their workspace',
    async (ws) => {
      const NativeWorker = globalThis.Worker
      const started: Worker[] = []
      const stopped = new Set<Worker>()
      globalThis.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options)
          started.push(this)
        }

        override terminate(): void {
          super.terminate()
          stopped.add(this)
        }
      }
      const peer = workspace()
      try {
        const command = 'echo a > /data/a; echo b > /data/b; diff /data/a /data/b'
        const expected = [1, '1c1\n< a\n---\n> b\n', '']
        equal(await shell(ws, command), expected)
        equal(await shell(ws, 'diff /data/a /data/b'), expected)
        equal(started.length, 1)
        equal(await shell(peer, command), expected)
        equal(started.length, 2)
        await peer.close()
        equal(stopped.size, 1)
        equal(await shell(ws, 'diff /data/a /data/b'), expected)
        equal(started.length, 2)
        await settle(async () => stopped.size === 2)
        equal(await shell(ws, 'diff /data/a /data/b'), expected)
        equal(started.length, 3)
        await ws.close()
        equal(stopped.size, 3)
      } finally {
        await Promise.allSettled([ws.close(), peer.close()])
        globalThis.Worker = NativeWorker
      }
    },
  ],
  [
    'diff reports unavailable workers and recovers when creation becomes available',
    async (ws) => {
      const NativeWorker = globalThis.Worker
      let attempts = 0
      globalThis.Worker = new Proxy(NativeWorker, {
        construct() {
          attempts += 1
          throw new DOMException('worker creation denied', 'SecurityError')
        },
      })
      try {
        const denied = await shell(ws, 'echo a > /data/a; echo b > /data/b; diff /data/a /data/b')
        equal(denied.slice(0, 2), [2, ''])
        equal(denied[2].includes('worker creation denied'), true)
        equal(attempts, 1)
      } finally {
        globalThis.Worker = NativeWorker
      }
      equal(await shell(ws, 'diff /data/a /data/b'), [1, '1c1\n< a\n---\n> b\n', ''])
    },
  ],
  [
    'an active diff can be cancelled while the page remains responsive and reused',
    async (ws) => {
      equal(await shell(ws, 'echo a > /data/a; echo b > /data/b'), [0, '', ''])
      const encode = new TextEncoder()
      await ws.vfs.write(
        '/data/old',
        encode.encode(
          Array.from({ length: 100_000 }, (_, index) => `old-${String(index)}\n`).join(''),
        ),
      )
      await ws.vfs.write(
        '/data/new',
        encode.encode(
          Array.from({ length: 100_000 }, (_, index) => `new-${String(index)}\n`).join(''),
        ),
      )
      const NativeWorker = globalThis.Worker
      const abort = new AbortController()
      let cancel: ReturnType<typeof setTimeout> | undefined
      let armed = false
      let ticks = 0
      let terminations = 0
      const timer = setInterval(() => {
        ticks += 1
      }, 1)
      globalThis.Worker = class extends NativeWorker {
        override postMessage(message: unknown, transfer: Transferable[]): void
        override postMessage(message: unknown, options?: StructuredSerializeOptions): void
        override postMessage(
          message: unknown,
          options?: Transferable[] | StructuredSerializeOptions,
        ): void {
          if (Array.isArray(options)) super.postMessage(message, options)
          else super.postMessage(message, options)
          if (
            typeof message !== 'object' ||
            message === null ||
            !('name' in message) ||
            message.name !== 'diffDispatch' ||
            !('args' in message) ||
            !Array.isArray(message.args)
          )
            return
          const request = DiffRequest.safeParse(message.args[0])
          if (request.success && request.data.kind === 'end' && request.data.index === 1) {
            armed = true
            ticks = 0
            cancel = setTimeout(() => abort.abort(), 15)
          }
        }

        override terminate(): void {
          super.terminate()
          terminations += 1
        }
      }
      try {
        equal(
          await aborted(shell(ws, 'diff /data/old /data/new', { signal: abort.signal })),
          'AbortError',
        )
        equal(armed, true)
        equal(ticks > 0, true)
        equal(terminations, 1)
        equal(await shell(ws, 'diff /data/a /data/b'), [1, '1c1\n< a\n---\n> b\n', ''])
      } finally {
        clearTimeout(cancel)
        clearInterval(timer)
        abort.abort()
        await ws.close()
        globalThis.Worker = NativeWorker
      }
    },
  ],
  [
    'cancelling rg on a long line releases the search',
    async (ws) => {
      await ws.vfs.write(
        '/data/rg-long',
        new TextEncoder().encode('a'.repeat(4 * 1024 * 1024) + '!\n'),
      )
      equal(await shell(ws, "rg 'event=[0-9]+.*status=fail' /data/rg-long"), [1, '', ''])
      const branches = Array.from({ length: 16 }, (_, index) => 'a'.repeat(index + 1)).join('|')
      const multiline = `^(${branches}|\\n)+b?$`
      await ws.vfs.write('/data/rg-multi-control', new TextEncoder().encode('aaa\naaa\n'))
      equal(await shell(ws, `rg -U -c '${multiline}' /data/rg-multi-control`), [0, '1\n', ''])
      for (const command of [
        `rg '^(${branches})+b?$' /data/rg-long`,
        `rg -U '${multiline}' /data/rg-long`,
      ]) {
        const abort = new AbortController()
        const running = ws.shell(command, { signal: abort.signal })
        setTimeout(() => abort.abort(), 25)
        equal(await aborted(running), 'AbortError')
        equal(await shell(ws, 'echo alive'), [0, 'alive\n', ''])
      }
    },
  ],
  [
    'overlapping sessions own their process-substitution descriptors',
    async (ws) => {
      ws.createSession('pipe-peer')
      let release!: () => void
      let enterBoth!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const both = new Promise<void>((resolve) => {
        enterBoth = resolve
      })
      let entered = 0
      ws.registerCli(
        'pipepause',
        new CLI({
          spec: new CommandSpec({ name: 'pipepause' }),
          handlers: {
            '': new CLIHandler({
              fn: async () => {
                if (++entered === 2) enterBoth()
                await held
                return [null, new IOResult()]
              },
            }),
          },
        }),
      )
      const left = shell(ws, 'cat <(pipepause; echo left) > >(cat)')
      const right = shell(ws, 'cat <(pipepause; echo right) > >(cat)', { sessionId: 'pipe-peer' })
      try {
        await both
        release()
        equal(await left, [0, 'left\n', ''])
        equal(await right, [0, 'right\n', ''])
        equal(await shell(ws, 'echo /dev/fd/*'), [0, '/dev/fd/*\n', ''])
      } finally {
        release()
        await Promise.allSettled([left, right])
      }
    },
  ],
  [
    'suspended sessions retain their permissions, umask and glob settings',
    async (ws) => {
      const loose = ws.createSession('loose')
      const tight = ws.createSession('tight', {
        profile: parseSessionProfile({
          mounts: { '/data': 'r' },
          paths: { hide: ['/data/private'] },
        }),
      })
      loose.umask = 0o022
      loose.shopts.dotglob = true
      loose.shopts.extglob = true
      tight.umask = 0o077
      let releaseLoose!: () => void
      let releaseTight!: () => void
      let enterBoth!: () => void
      const looseHeld = new Promise<void>((resolve) => {
        releaseLoose = resolve
      })
      const tightHeld = new Promise<void>((resolve) => {
        releaseTight = resolve
      })
      const bothEntered = new Promise<void>((resolve) => {
        enterBoth = resolve
      })
      let entered = 0
      ws.registerCli(
        'pause',
        new CLI({
          spec: new CommandSpec({ name: 'pause' }),
          handlers: {
            '': new CLIHandler({
              fn: async (_accessor, _paths, _texts, ctx) => {
                if (++entered === 2) enterBoth()
                await (ctx.env?.LABEL === 'loose' ? looseHeld : tightHeld)
                return [null, new IOResult()]
              },
            }),
          },
        }),
      )
      try {
        for (const name of ['a', 'b', '.hidden', 'private'])
          await ws.vfs.write(`/data/${name}`, name)
        const wide = shell(
          ws,
          'pause; mkdir /data/new; stat -c %a /data/new; echo /data/*; echo /data/@(a|b); p="/data/@(a|b)"; echo hi > $p',
          { sessionId: loose.sessionId, env: { LABEL: 'loose' } },
        )
        const narrow = shell(ws, 'pause; echo /data/*; mkdir /data/denied', {
          sessionId: tight.sessionId,
        })
        await bothEntered
        releaseLoose()
        const output = await wide
        releaseTight()
        const denied = await narrow
        equal(output.slice(0, 2), [
          1,
          '755\n/data/.hidden /data/a /data/b /data/new /data/private\n/data/a /data/b\n',
        ])
        equal(output[2].includes('ambiguous redirect'), true)
        equal(denied.slice(0, 2), [1, '/data/a /data/b /data/new\n'])
        equal(denied[2].includes('Read-only file system'), true)
      } finally {
        releaseLoose()
        releaseTight()
      }
    },
  ],
  [
    'bundled computation workers execute searches, jq, sort and diff',
    async (ws) => {
      equal(await shell(ws, "printf 'bbb\\n' | rg --count-matches 'a*|b+'"), [0, '4\n', ''])
      equal(await shell(ws, "printf 'abc\\n' | grep b"), [0, 'abc\n', ''])
      equal(await shell(ws, "printf '2\\n1\\n' | sort -n"), [0, '1\n2\n', ''])
      equal(await shell(ws, 'printf \'{"x":7}\' | jq .x'), [0, '7\n', ''])
      equal(await shell(ws, 'echo a > /data/a; echo b > /data/b; diff /data/a /data/b'), [
        1,
        '1c1\n< a\n---\n> b\n',
        '',
      ])
    },
  ],
  [
    'a bundled regexp worker can be interrupted',
    async (ws) => {
      const controller = new AbortController()
      const running = aborted(
        shell(ws, "printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!\\n' | grep -P '^(a+)+$'", {
          signal: controller.signal,
        }),
      )
      const timer = setTimeout(() => controller.abort(), 250)
      try {
        equal(await running, 'AbortError')
        equal(await shell(ws, 'echo ready'), [0, 'ready\n', ''])
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    },
  ],
  [
    'a slow back-reference grep can be interrupted',
    async (ws) => {
      const controller = new AbortController()
      const running = aborted(
        shell(ws, "printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!\\n' | grep -E '^(a*)*\\1b$'", {
          signal: controller.signal,
        }),
      )
      const timer = setTimeout(() => controller.abort(), 250)
      try {
        equal(await running, 'AbortError')
        equal(await shell(ws, 'echo ready'), [0, 'ready\n', ''])
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    },
  ],

  ...ICONV_MULTIBYTE_DIGESTS.map(([spec, ...expected]): [string, Check] => [
    `iconv ${spec.name} decode and reverse tables match the pinned digests`,
    async () => {
      equal(await iconvMultibyteDigests(spec), expected)
    },
  ]),
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
        new CLI({
          spec: new CommandSpec({ name: 'stall' }),
          handlers: {
            '': new CLIHandler({
              fn: async () => {
                enter()
                await gate
                return [null, new IOResult()]
              },
            }),
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
