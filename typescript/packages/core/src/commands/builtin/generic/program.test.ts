import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { IOResult, materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { createShellParser } from '../../../shell/parse/index.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { prepareProgram } from './program.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../../../../integ/crossmount/program/files.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: { id: string; command: string; expect: { exit: number; stdout: string; stderr: string } }[]
}

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

  for (const test of corpus.cases) {
    it(test.id, async () => {
      const ws = new Workspace(
        { '/data': new RAMVFS(), '/data2': new RAMVFS() },
        {
          mode: MountMode.EXEC,
          shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
        },
      )
      try {
        const result = await ws.shell(test.command)
        const dec = new TextDecoder()
        expect({
          exit: result.exitCode,
          stdout: dec.decode(result.stdout),
          stderr: dec.decode(result.stderr),
        }).toEqual(test.expect)
      } finally {
        await ws.close()
      }
    })
  }
})

function typed(raw: string): PathSpec {
  const virtual = raw.startsWith('/') ? raw : `/${raw}`
  return new PathSpec({ virtual, directory: '/', vfsPath: '', resolved: true, rawPath: raw })
}

const noDispatch = ((op: string, path: PathSpec) => {
  throw new Error(`stdin only, but ${op} ${path.virtual} was dispatched`)
}) as unknown as DispatchFn

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe('rg program files from stdin', () => {
  it('lowers a -f - to --regexp', async () => {
    const [texts, flags, rest, error] = await prepareProgram(
      'rg',
      ['/in'],
      { file: ['-'] },
      ENC.encode('a\nb\n'),
      noDispatch,
    )
    expect(error).toBeNull()
    expect([texts, flags]).toEqual([['/in'], { file: [], regexp: ['a\nb'] }])
    expect(await materialize(rest)).toEqual(new Uint8Array())
  })

  it('refuses a second -f -', async () => {
    // ripgrep 14.1.1: `rg -f - -f -` reads stdin once and refuses the second
    // before any operand is looked at.
    const [, , , error] = await prepareProgram(
      'rg',
      [],
      { file: ['-', '-'] },
      ENC.encode('a\n'),
      noDispatch,
      [typed('-')],
    )
    expect(error?.exitCode).toBe(2)
    expect(DEC.decode(error?.stderr as Uint8Array)).toBe(
      'rg: error reading -f/--file from stdin: stdin has already been consumed\n',
    )
  })

  it('refuses a - operand after -f -', async () => {
    const [, , , error] = await prepareProgram(
      'rg',
      [],
      { file: ['-'] },
      ENC.encode('a\n'),
      noDispatch,
      [typed('/in'), typed('-')],
    )
    expect(error?.exitCode).toBe(2)
    expect(DEC.decode(error?.stderr as Uint8Array)).toBe(
      'rg: error: attempted to read patterns from stdin while also searching stdin\n',
    )
  })

  it('takes no - from -f /dev/stdin', async () => {
    // ripgrep reads `-f /dev/stdin` as a file, so a `-` operand after it
    // searches what is left of stdin (nothing) rather than being refused.
    const [, flags, rest, error] = await prepareProgram(
      'rg',
      [],
      { file: ['/dev/stdin'] },
      ENC.encode('a\n'),
      noDispatch,
      [typed('-')],
    )
    expect(error).toBeNull()
    expect(flags).toEqual({ file: [], regexp: ['a'] })
    expect(await materialize(rest)).toEqual(new Uint8Array())
  })

  it('leaves grep reading a second -f - as empty', async () => {
    // GNU grep 3.11 reads the second `-f -` as an empty pattern file.
    const [, flags, , error] = await prepareProgram(
      'grep',
      [],
      { file: ['-', '-'], e: [] },
      ENC.encode('a\n'),
      noDispatch,
      [typed('-')],
    )
    expect(error).toBeNull()
    expect(flags).toEqual({ file: [], e: ['a'] })
  })
})
