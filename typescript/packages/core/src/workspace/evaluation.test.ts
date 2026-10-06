import * as executionTree from './node/run_tree.ts'
import { afterEach, assert, expect, test, vi } from 'vitest'
import { CLISpec } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { Channel } from '../shell/console/index.ts'
import { ProgramNode, type ParsedProgram } from '../shell/parse/program.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { SessionState } from './session/session.ts'
import { seedVar } from './session/state.ts'
import { Workspace } from './workspace/workspace.ts'
import { childSession, executionSession } from './evaluation.ts'
import type { TSNodeLike } from '../shell/types.ts'

afterEach(() => vi.restoreAllMocks())

const it = test.extend<{ owned: { ws: Workspace; programs: ParsedProgram[] } }>({
  // eslint-disable-next-line no-empty-pattern -- Vitest requires destructuring for fixture dependencies.
  owned: async ({}, use) => {
    const parser = await getTestParser()
    const programs: ParsedProgram[] = []
    const original = parser.parseProgram.bind(parser)
    vi.spyOn(parser, 'parseProgram').mockImplementation((source) => {
      const program = original(source)
      programs.push(program)
      return program
    })
    const ws = new Workspace({}, { shellParser: parser })
    try {
      await use({ ws, programs })
    } finally {
      await ws.close()
      expect(programs.every((program) => program.references === 0)).toBe(true)
    }
  },
})

it('keeps temporary frames off persistent state and child writes off the parent', () => {
  const state = new SessionState({ sessionId: 's' })
  const first = executionSession(state)
  first.diagnostics.push('first')
  first.cmdsubSeq = 4
  seedVar(first, 'NAME', 'parent')
  const second = executionSession(state)
  const child = childSession(first)
  seedVar(child, 'NAME', 'child')
  expect(second.diagnostics).toEqual([])
  expect(second.cmdsubSeq).toBe(0)
  expect(state.env.NAME).toBe('parent')
  expect(Object.hasOwn(state, 'diagnostics')).toBe(false)
  expect(Object.hasOwn(state, 'abortSignal')).toBe(false)
})

it('retains a background function through late substitutions and foreground unset', async ({
  owned: { ws },
}) => {
  const gate = barrier()
  installStall(ws, gate)
  try {
    await ws.shell('f() { echo retained; }')
    const stored = ws.getSession(ws.defaultSessionId).functions.f as TSNodeLike[]
    assert(stored[0] instanceof ProgramNode)
    const defining = stored[0].program
    await ws.shell('{ stall; echo "$(f):$(</dev/null)"; } &')
    await gate.entered
    await ws.shell('unset -f f')
    expect(defining.references).toBeGreaterThan(0)
    const job = ws.jobTable.get(1, ws.defaultSessionId)
    assert(job)
    gate.release()
    await ws.shell('wait')
    expect(job.exitCode).toBe(0)
    expect(new TextDecoder().decode(await job.console.snapshot(Channel.STDERR))).toBe('')
    expect(new TextDecoder().decode(await job.console.snapshot(Channel.STDOUT))).toBe('retained:\n')
    expect(defining.references).toBe(0)
  } finally {
    gate.release()
  }
})

it('explain borrows function programs without retaining another session', async ({
  owned: { ws, programs },
}) => {
  await ws.shell('f() { echo retained; }')
  const before = programs.map((program) => program.references)
  await ws.explain('cd /; f')
  expect(programs.slice(0, before.length).map((program) => program.references)).toEqual(before)
})

it.for([
  ['self-unset', 'f() { unset -f f; echo alive; }; f', 'alive\n', 0],
  ['early return', 'f() { unset -f f; return 7; }; f', '', 7],
  ['self-redefinition', 'f() { f() { echo new; }; echo old; }; f; f', 'old\nnew\n', 0],
  ['pipeline', 'f() { echo alive; }; f | cat', 'alive\n', 0],
  ['parallel xargs', 'f() { echo "$1"; }; printf "x\\nx\\n" | xargs -P 2 -n 1 f', 'x\nx\n', 0],
  ['subshell', '(f() { echo alive; }; f)', 'alive\n', 0],
  ['nested bash', "bash -c 'f() { echo alive; }; f'", 'alive\n', 0],
] as const)(
  'releases function programs after %s',
  async ([_name, command, stdout, exitCode], { owned: { ws, programs } }) => {
    const io = await ws.shell(command)
    expect([io.exitCode, io.stdoutText, io.stderrText]).toEqual([exitCode, stdout, ''])
    await ws.shell('unset -f f')
    expect(programs.every((program) => program.references === 0)).toBe(true)
  },
)

it('closing one workspace leaves its injected parser usable by another', async () => {
  const parser = await getTestParser()
  const first = new Workspace({}, { shellParser: parser })
  const second = new Workspace({}, { shellParser: parser })
  await first.shell('f() { echo first; }')
  await first.close()
  try {
    const io = await second.shell('echo second')
    expect(new TextDecoder().decode(io.stdout)).toBe('second\n')
  } finally {
    await second.close()
  }
})

it('keeps substitution writes off its parent while suspended', async ({ owned: { ws } }) => {
  const gate = barrier()
  installStall(ws, gate)
  const pending = ws.shell('X=parent; value=$(X=child; stall; echo "$X"); echo "$X:$value"')
  try {
    await gate.entered
    expect(ws.getSession(ws.defaultSessionId).env.X).toBe('parent')
    gate.release()
    const io = await pending
    expect(io.stdoutText).toBe('parent:child\n')
    expect(io.exitCode).toBe(0)
  } finally {
    gate.release()
    await pending
  }
})

it('keeps a cancelled tree alive until a blocked leaf actually settles', async ({
  owned: { ws, programs },
}) => {
  const gate = barrier()
  const run = executionTree.runCommandTree
  let borrowed = ''
  const executing = vi
    .spyOn(executionTree, 'runCommandTree')
    .mockImplementation(async (...args) => {
      await gate.pause()
      borrowed = args[1].text
      return run(...args)
    })
  const abort = new AbortController()
  const pending = ws.shell('echo forbidden', { signal: abort.signal })
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  try {
    await gate.entered
    abort.abort()
    await cancelled
    expect(programs.some((program) => program.references > 0)).toBe(true)
    gate.release()
    await vi.waitFor(() => {
      expect(programs.every((program) => program.references === 0)).toBe(true)
    })
    expect(borrowed).toBe('echo forbidden')
    executing.mockRestore()
    expect((await ws.shell('echo alive')).stdoutText).toBe('alive\n')
  } finally {
    gate.release()
    await cancelled
  }
})

function barrier(): { entered: Promise<void>; pause: () => Promise<void>; release: () => void } {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    pause: async () => {
      enter()
      await gate
    },
  }
}

function installStall(ws: Workspace, gate: ReturnType<typeof barrier>): void {
  ws.registerCli(
    'stall',
    new CLISpec({
      name: 'stall',
      fn: async () => {
        await gate.pause()
        return [null, new IOResult()]
      },
    }),
  )
}
