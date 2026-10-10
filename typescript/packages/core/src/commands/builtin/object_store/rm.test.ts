import { expect, it, vi } from 'vitest'
import { materialize } from '../../../io/types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { withCommandGuards } from '../generic_bind/adapter.ts'
import type { CommandIO } from '../../config.ts'
import { makeRm } from './rm.ts'

it.each([
  [
    false,
    'ELOOP',
    'loop/child',
    1,
    "rm: cannot remove 'loop/child': Too many levels of symbolic links\n",
  ],
  [true, 'ENOENT', '', 0, ''],
] as const)(
  'rm handles a refused operand under -f=%s (%s) and continues',
  async (force, refusal, raw, code, err) => {
    const stat = vi.fn(() => Promise.resolve(new FileStat({ name: 'ok', type: FileType.FILE })))
    const unlink = vi.fn(() => Promise.resolve())
    const io: CommandIO = {
      readdir: () => Promise.resolve([]),
      readBytes: () => Promise.resolve(new Uint8Array()),
      readStream: () => {
        throw new Error('unexpected read')
      },
      stat,
      unlink,
      rmdir: unlink,
      rmR: unlink,
      isMounted: () => true,
    }
    const command = makeRm('s3', withCommandGuards)[0]
    if (command === undefined) throw new Error('rm was not registered')
    const refused = new PathSpec({
      virtual: '/data',
      directory: '/',
      vfsPath: 'data',
      rawPath: raw,
      walkError: refusal,
    })
    const valid = PathSpec.fromStrPath('/data/ok')
    const result = await command.fn({} as Accessor, [refused, valid], [], {
      flags: { f: force },
      stdin: null,
      cwd: '/',
      io,
    })
    await materialize(result?.[0] ?? null)
    expect(result?.[1].exitCode).toBe(code)
    expect(new TextDecoder().decode(await materialize(result?.[1].stderr ?? null))).toBe(err)
    expect(stat).toHaveBeenCalledTimes(1)
    expect(unlink.mock.calls).toHaveLength(1)
  },
)
