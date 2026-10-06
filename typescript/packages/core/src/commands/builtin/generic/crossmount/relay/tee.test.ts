import { expect, it } from 'vitest'
import { IOResult } from '../../../../../io/types.ts'
import type { DispatchFn } from '../../../../../runtime/types.ts'
import { MountMode, PathSpec } from '../../../../../types.ts'
import { enoent } from '../../../../../utils/errors.ts'
import { RAMVFS } from '../../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../../../workspace/fixtures/workspace_fixture.ts'
import { runTee } from './tee.ts'

const DEC = new TextDecoder()

it('relay tee checks every output before writing any', async () => {
  const ws = new Workspace(
    { '/a': new RAMVFS(), '/b': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const result = await ws.shell('printf x | tee --output-error=exit /a/one /b/nope/two /a/three')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stdout)).toBe('')
    expect(DEC.decode(result.stderr)).toBe('tee: /b/nope/two: No such file or directory\n')
    const listing = await ws.shell('ls /a; cat /a/one; printf y | tee /a/one /b/two')
    expect(DEC.decode(listing.stdout)).toBe('one\ny')
    expect(DEC.decode((await ws.shell('cat /a/one /b/two')).stdout)).toBe('yy')
  } finally {
    await ws.close()
  }
})

it('relay tee -a appends through the append op', async () => {
  const ops: [string, string][] = []
  const dispatch: DispatchFn = (op, path) => {
    ops.push([op, path.virtual])
    if (op === 'stat') return Promise.reject(enoent(path))
    return Promise.resolve([null, new IOResult()])
  }
  const outputs = ['/a/f', '/b/g'].map(
    (v) => new PathSpec({ virtual: v, directory: v, vfsPath: v, rawPath: v, resolved: true }),
  )
  const [out, io] = await runTee(outputs, { append: true }, dispatch, new TextEncoder().encode('x'))
  expect(io.exitCode).toBe(0)
  expect(DEC.decode(out as Uint8Array)).toBe('x')
  expect(ops.filter(([op]) => op !== 'stat')).toEqual([
    ['append', '/a/f'],
    ['append', '/b/g'],
  ])
})
