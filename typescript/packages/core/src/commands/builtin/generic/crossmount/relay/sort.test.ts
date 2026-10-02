import { expect, it } from 'vitest'
import { MountMode } from '../../../../../types.ts'
import { RAMVFS } from '../../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../../../workspace/fixtures/workspace_fixture.ts'

class CachedRAM extends RAMVFS {
  override readonly cachesReads = true
}

it.each([false, true])('caches relayed inputs (overwrite=%s)', async (overwrite) => {
  const enc = new TextEncoder()
  const left = new CachedRAM()
  const right = new CachedRAM()
  left.loadState({ type: 'ram', files: { '/input': enc.encode('z\na\n') } })
  right.loadState({ type: 'ram', files: { '/input': enc.encode('m\n') } })
  const ws = new Workspace(
    { '/a': left, '/b': right },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const command = 'sort /a/input /b/input'
  try {
    const result = await ws.shell(command + (overwrite ? ' -o /a/input' : ''))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toEqual(enc.encode(overwrite ? '' : 'a\nm\nz\n'))
    // The relay writes the replacement through the dispatcher, which evicts
    // it; only a read lands in the cache.
    expect(await ws.cache.get('/a/input')).toEqual(overwrite ? null : enc.encode('z\na\n'))
    expect(await ws.cache.get('/b/input')).toEqual(enc.encode('m\n'))
    left.loadState({ type: 'ram', files: { '/input': enc.encode('changed\n') } })
    const again = await ws.shell(overwrite ? 'cat /a/input' : command)
    expect(again.stdout).toEqual(enc.encode(overwrite ? 'changed\n' : 'a\nm\nz\n'))
  } finally {
    await ws.close()
  }
})
