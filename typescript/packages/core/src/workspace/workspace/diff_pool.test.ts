import { afterEach, expect, it, vi } from 'vitest'
import { Worker } from '../../concurrency/worker.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { stdoutStr } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { DiffRequest } from '../../rs/diff_worker.ts'
import { Workspace } from './workspace.ts'

const workspaces: Workspace[] = []
afterEach(async () => {
  await Promise.allSettled(workspaces.splice(0).map((workspace) => workspace.close()))
  vi.restoreAllMocks()
})

it('owns warm diff workers across single-mount and cross-mount commands', async () => {
  const workspace = new Workspace(
    {
      '/a': [new RAMVFS(), MountMode.WRITE],
      '/b': [new RAMVFS(), MountMode.WRITE],
    },
    { mode: MountMode.WRITE },
  )
  workspaces.push(workspace)
  await workspace.shell('echo old > /a/old; echo new > /a/new; echo new > /b/new')
  const calls = vi.spyOn(Worker.prototype, 'call')
  const first = await workspace.shell('diff /a/old /a/new')
  const second = await workspace.shell('diff /a/old /b/new')
  expect(first.exitCode).toBe(1)
  expect(stdoutStr(first)).toBe('1c1\n< old\n---\n> new\n')
  expect(stdoutStr(second)).toBe(stdoutStr(first))
  const owners = calls.mock.calls.flatMap(([name, args], index) =>
    name === 'diffDispatch' && DiffRequest.parse(args[0]).kind === 'open'
      ? [calls.mock.instances[index]]
      : [],
  )
  expect(owners).toHaveLength(2)
  expect(owners[0]).toBe(owners[1])
  const close = vi.spyOn(Worker.prototype, 'close')
  await workspace.close()
  expect(close).toHaveBeenCalledOnce()
})

it('closes the diff pool and VFS even when execution settlement fails', async () => {
  const backend = new RAMVFS()
  const workspace = new Workspace(
    { '/a': [backend, MountMode.WRITE] },
    {
      mode: MountMode.WRITE,
    },
  )
  workspaces.push(workspace)
  await workspace.shell('echo old > /a/old; echo new > /a/new; diff /a/old /a/new')
  const failing = await workspace.shell('sleep 10', { stream: true })
  const closeExecution = vi
    .spyOn(failing, 'close')
    .mockRejectedValue(new Error('execution close failed'))
  const closeWorker = vi.spyOn(Worker.prototype, 'close')
  const closeBackend = vi.spyOn(backend, 'close')
  try {
    await expect(workspace.close()).rejects.toThrow()
    expect(closeWorker).toHaveBeenCalledOnce()
    expect(closeBackend).toHaveBeenCalledOnce()
  } finally {
    closeExecution.mockRestore()
    await failing.close()
  }
})
