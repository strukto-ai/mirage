import { expect, it } from 'vitest'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { MountMode } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'

function workspace(): Workspace {
  const ws = new Workspace({ '/repo': new RAMVFS() }, { mode: MountMode.WRITE })
  ws.registerCli('git', GIT)
  return ws
}
it('initializes, reinitializes safely, and inspects empty repositories', async () => {
  const ws = workspace()
  try {
    for (const command of [
      'mkdir -p /repo/project/.git',
      'git init -q -b main /repo/project',
      'git -C /repo/project stash list',
      'git init -q /repo/project',
    ]) {
      const result = await ws.shell(command)
      expect(new TextDecoder().decode(result.stderr)).toBe('')
      expect(result.exitCode).toBe(0)
    }
    expect(new TextDecoder().decode((await ws.shell('cat /repo/project/.git/HEAD')).stdout)).toBe(
      'ref: refs/heads/main\n',
    )
    const result = await ws.shell('git -C /repo/project fsck')
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toBe(
      'notice: HEAD points to an unborn branch (main)\nnotice: No default references\n',
    )
    expect((await ws.shell('git -C /repo/project stash show')).exitCode).toBe(1)
    expect((await ws.shell('git help')).stdout).toEqual((await ws.shell('git --help')).stdout)
    expect((await ws.shell('git help status')).stdout).toEqual(
      (await ws.shell('git status --help')).stdout,
    )
  } finally {
    await ws.close()
  }
})
