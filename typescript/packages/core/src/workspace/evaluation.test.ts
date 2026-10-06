import * as executionTree from './node/run_tree.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { CLISpec } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { ProgramNode, type ParsedProgram } from '../shell/parse/program.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { SessionState } from './session/session.ts'
import { seedVar } from './session/state.ts'
import { Workspace } from './workspace/workspace.ts'
import { childSession, executionSession } from './evaluation.ts'
import type { TSNodeLike } from '../shell/types.ts'

afterEach(() => vi.restoreAllMocks())

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

it('retains trees through background output and releases them after teardown', async () => {
  const parser = await getTestParser()
  const programs: ParsedProgram[] = []
  const original = parser.parseProgram.bind(parser)
  vi.spyOn(parser, 'parseProgram').mockImplementation((source) => {
    const program = original(source)
    programs.push(program)
    return program
  })
  const ws = new Workspace({}, { shellParser: parser })
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
  try {
    await ws.shell('f() { echo retained; }')
    const stored = ws.getSession(ws.defaultSessionId).functions.f as TSNodeLike[]
    expect(stored[0]).toBeInstanceOf(ProgramNode)
    const defining = (stored[0] as ProgramNode).program
    const references = defining.references
    await ws.explain('cd /; f')
    expect(defining.references).toBe(references)
    await ws.shell('{ stall; f; } &')
    await entered
    await ws.shell('unset -f f')
    expect(defining.references).toBeGreaterThan(0)
    release()
    await ws.shell('wait')
    expect(defining.references).toBe(0)
    await ws.shell('f() { unset -f f; echo alive; }; f')
    await ws.shell('f() { :; }; f | f; echo x | xargs -P 2 -n 1 f; (f); bash -c f; unset -f f')
  } finally {
    release()
    await ws.close()
  }
  expect(programs.filter((program) => program.references !== 0)).toEqual([])
})

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

it('keeps substitution writes off its parent while suspended', async () => {
  const ws = new Workspace({}, { shellParser: await getTestParser() })
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
  const pending = ws.shell('X=parent; value=$(X=child; stall; echo "$X"); echo "$X:$value"')
  try {
    await entered
    expect(ws.getSession(ws.defaultSessionId).env.X).toBe('parent')
    release()
    const io = await pending
    expect(io.stdoutText).toBe('parent:child\n')
    expect(io.exitCode).toBe(0)
  } finally {
    release()
    await pending
    await ws.close()
  }
})

it('keeps a cancelled tree alive until a blocked leaf actually settles', async () => {
  const parser = await getTestParser()
  const programs: ParsedProgram[] = []
  const original = parser.parseProgram.bind(parser)
  vi.spyOn(parser, 'parseProgram').mockImplementation((source) => {
    const program = original(source)
    programs.push(program)
    return program
  })
  const ws = new Workspace({}, { shellParser: parser })
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const run = executionTree.runCommandTree
  let borrowed = ''
  vi.spyOn(executionTree, 'runCommandTree').mockImplementation(async (...args) => {
    enter()
    await gate
    borrowed = args[1].text
    return run(...args)
  })
  const abort = new AbortController()
  const pending = ws.shell('echo forbidden', { signal: abort.signal })
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  try {
    await entered
    abort.abort()
    await cancelled
    expect(programs.some((program) => program.references > 0)).toBe(true)
    release()
    await vi.waitFor(() => {
      expect(programs.every((program) => program.references === 0)).toBe(true)
    })
    expect(borrowed).toBe('echo forbidden')
    vi.restoreAllMocks()
    expect((await ws.shell('echo alive')).stdoutText).toBe('alive\n')
  } finally {
    release()
    await cancelled
    await ws.close()
  }
})
