import { expect, it } from 'vitest'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { command } from '../../commands/config.ts'
import { SPECS } from '../../commands/spec/index.ts'
import { CommandTimeoutError } from '../../commands/errors.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { PathSpec } from '../../types.ts'
import { eacces } from '../../utils/errors.ts'
import { MountEntry } from '../mount/mount.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { Workspace } from '../workspace/workspace.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

function failingCommand(name: string, error: Error, lazy = true) {
  async function* stream() {
    yield await Promise.resolve(ENC.encode('/bad/visible\n'))
    throw error
  }
  const spec = SPECS[name]
  if (spec === undefined) throw new Error(`Missing spec: ${name}`)
  return command({
    name,
    vfs: 'ram',
    spec,
    fn: () => {
      if (!lazy) throw error
      return [stream(), new IOResult()]
    },
  })
}

it.each([
  ['; echo after=$?', 'before\n/bad/visible\nafter=1\n'],
  [' | head -10; echo after=$?', 'before\n/bad/visible\nafter=0\n'],
  [' >/out/file; echo after=$?; cat /out/file', 'before\nafter=1\n/bad/visible\n'],
])('keeps lazy failures on the producer: %s', async (tail, expected) => {
  for (const error of [eacces('/bad/closed'), new Error('remote failure')]) {
    const bad = new RAMVFS()
    const ws = new Workspace(
      { '/bad': bad, '/out': new RAMVFS() },
      { mode: 'exec', shellParser: await getTestParser() },
    )
    for (const cmd of failingCommand('cat', error)) ws.registry.mountFor('/bad/f').register(cmd)
    try {
      await ws.shell('echo data >/bad/f')
      const result = await ws.shell('echo before; cat /bad/f 2>/dev/null' + tail)
      expect(DEC.decode(result.stdout)).toBe(expected)
      expect(DEC.decode(result.stderr)).toBe('')
      expect(result.exitCode).toBe(0)
      const failed = await ws.shell('cat /bad/f')
      expect(DEC.decode(failed.stdout)).toBe('/bad/visible\n')
      expect(DEC.decode(failed.stderr)).toMatch(/^cat: /)
      expect(failed.exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  }
})

class FailingListing extends RAMVFS {
  override ops(): readonly RegisteredOp[] {
    return super
      .ops()
      .map((ro) =>
        ro.name === 'readdir'
          ? { ...ro, fn: () => Promise.reject(new Error('remote failure')) }
          : ro,
      )
  }
}

it.each(['find', 'du', 'ls -R'])('keeps nested %s failure inside the line', async (name) => {
  const ws = new Workspace(
    { '/bad': new FailingListing(), '/good': new RAMVFS() },
    { mode: 'exec', shellParser: await getTestParser() },
  )
  try {
    await ws.shell('echo data >/good/file')
    const result = await ws.shell(`echo before; ${name} / 2>/dev/null; echo after=$?`)
    expect(DEC.decode(result.stdout)).toBe('before\nafter=1\n')
    expect(DEC.decode(result.stderr)).toBe('')
    const failed = await ws.shell(`${name} /`)
    expect(DEC.decode(failed.stderr)).toBe(`${name.split(' ')[0] ?? ''}: remote failure\n`)
    expect(failed.exitCode).toBe(1)
  } finally {
    await ws.close()
  }
})

it('does not convert a lazy timeout into a normal failure', async () => {
  const vfs = new RAMVFS()
  const mount = new MountEntry({ prefix: '/bad/', vfs })
  for (const cmd of failingCommand('cat', new CommandTimeoutError('cat', 1))) mount.register(cmd)
  const [out] = await mount.executeCmd('cat', [PathSpec.fromStrPath('/bad/f')], [], {})
  await expect(materialize(out)).rejects.toBeInstanceOf(CommandTimeoutError)
})
