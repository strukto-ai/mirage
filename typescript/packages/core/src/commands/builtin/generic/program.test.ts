import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { IOResult, materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { createShellParser } from '../../../shell/parse/index.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../../types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { prepareProgram, readProgramFile } from './program.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

describe('program file routing', () => {
  it.each([
    ['grep', '-rn pattern', ['-rn', 'pattern']],
    ['sed', '-n p', ['-n', 'p']],
    ['awk', '-F : program', ['-F', ':', 'program']],
    ['jq', '-r .a', ['-r', '.a']],
  ])('leaves inline %s arguments to the mount spec', async (name, args, texts) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      const mount = ws.registry.mountFor('/data')
      vi.spyOn(mount, 'specFor').mockReturnValue(null)
      const execute = vi.spyOn(mount, 'executeCmd').mockResolvedValue([null, new IOResult()])
      const result = await ws.shell(`${name} ${args} /data/input`)
      expect(result.exitCode).toBe(0)
      expect(execute).toHaveBeenCalledOnce()
      expect(execute.mock.calls[0]?.[2]).toEqual(texts)
      expect(execute.mock.calls[0]?.[3]).toEqual({})
    } finally {
      await ws.close()
    }
  })
})

function typed(raw: string): PathSpec {
  const virtual = raw.startsWith('/') ? raw : `/${raw}`
  return new PathSpec({ virtual, directory: '/', vfsPath: '', resolved: true, rawPath: raw })
}

const noDispatch = ((op: string, path: PathSpec) => {
  throw new Error(`stdin only, but ${op} ${path.virtual} was dispatched`)
}) as unknown as DispatchFn

const ENC = new TextEncoder()

describe('rg program files from stdin', () => {
  it('lowers a -f - to --regexp', async () => {
    const [texts, flags, rest, error] = await prepareProgram(
      'rg',
      ['/in'],
      { file: [typed('-')] },
      ENC.encode('a\nb\n'),
      noDispatch,
    )
    expect(error).toBeNull()
    expect([texts, flags]).toEqual([['/in'], { file: [], regexp: ['a\nb'] }])
    expect(await materialize(rest)).toEqual(new Uint8Array())
  })
})

describe('a program file the command cannot read', () => {
  it.each([
    ['sed', true],
    ['grep', false],
  ])('reads a directory as %s reads it', async (name, empty) => {
    // sed 4.9 reads a directory as an empty script; everyone else fails its
    // read, which the stat tells from a keyed store's plain miss.
    const dispatch: DispatchFn = (op, path) => {
      if (op !== 'stat') throw new Error(`${op} ${path.virtual} was dispatched`)
      return Promise.resolve([
        new FileStat({ name: 'dir', type: FileType.DIRECTORY }),
        new IOResult(),
      ])
    }
    const read = readProgramFile(name, typed('dir'), dispatch)
    if (empty) expect((await read).byteLength).toBe(0)
    else await expect(read).rejects.toMatchObject({ code: 'EISDIR' })
  })
})
