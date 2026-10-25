// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const cliMain = vi.hoisted(() => vi.fn<(argv: string[]) => Promise<void>>())
vi.mock('./main.ts', () => ({ main: cliMain }))

const { PROG, main, splitArgs, workingDirectory } = await import('./bash.ts')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  cliMain.mockReset()
})

describe('splitArgs', () => {
  it.each([
    [['-c', 'ls -la']],
    [['-c', '-l', 'ls -la']],
    [['-lc', 'ls -la']],
    [['--login', '-c', 'ls -la']],
    [['-o', 'pipefail', '-c', 'ls -la']],
    [['-c', '--', 'ls -la']],
  ])('takes the first operand after the options as the line: %j', (argv) => {
    expect(splitArgs(argv)).toBe('ls -la')
  })

  it('takes a line that starts with a dash after the end of options', () => {
    expect(splitArgs(['-c', '--', '-x'])).toBe('-x')
  })

  it.each([
    [[], 'only -c is supported'],
    [['script.sh'], 'only -c is supported'],
    [['-c'], '-c: option requires an argument'],
    [['-c', 'echo $0', 'name'], 'operands after the line are not supported'],
  ])('refuses anything but one line after -c: %j', (argv, message) => {
    expect(() => splitArgs(argv)).toThrow(message)
  })
})

describe('workingDirectory', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mirage-bash-')))
  const real = join(root, 'real')
  const link = join(root, 'link')
  mkdirSync(real)
  mkdirSync(join(root, 'elsewhere'))
  symlinkSync(real, link)

  it('names the directory by $PWD when it is the same one', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(real)
    vi.stubEnv('PWD', link)
    expect(workingDirectory()).toBe(link)
  })

  it.each([join(root, 'elsewhere'), 'relative/path', join(root, 'missing')])(
    'keeps the resolved path over a $PWD that is not it: %s',
    (pwd) => {
      vi.spyOn(process, 'cwd').mockReturnValue(real)
      vi.stubEnv('PWD', pwd)
      expect(workingDirectory()).toBe(real)
    },
  )
})

describe('main', () => {
  const here = realpathSync(tmpdir())

  function exits() {
    return vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`)
    })
  }

  it('runs the line as mirage shell from the working directory', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(here)
    vi.stubEnv('PWD', here)
    vi.stubEnv('MIRAGE_WORKSPACE', 'demo')
    vi.stubEnv('MIRAGE_SESSION', 'agent')
    await main(['-c', '-l', 'ls | wc -l'])
    expect(cliMain).toHaveBeenCalledWith([
      'shell',
      '-w',
      'demo',
      `--cwd=${here}`,
      '-s',
      'agent',
      '--command=ls | wc -l',
    ])
  })

  it('runs as the default session when none is named', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(here)
    vi.stubEnv('PWD', here)
    vi.stubEnv('MIRAGE_WORKSPACE', 'demo')
    vi.stubEnv('MIRAGE_SESSION', '')
    await main(['-c', 'pwd'])
    expect(cliMain).toHaveBeenCalledWith(['shell', '-w', 'demo', `--cwd=${here}`, '--command=pwd'])
  })

  it('exits 2 when no workspace is named', async () => {
    const exit = exits()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubEnv('MIRAGE_WORKSPACE', '')
    await expect(main(['-c', 'pwd'])).rejects.toThrow('exit 2')
    expect(exit).toHaveBeenCalledWith(2)
    expect(error).toHaveBeenCalledWith(`${PROG}: MIRAGE_WORKSPACE is not set`)
    expect(cliMain).not.toHaveBeenCalled()
  })

  it('exits 2 on a bad argument list', async () => {
    exits()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubEnv('MIRAGE_WORKSPACE', 'demo')
    await expect(main(['script.sh'])).rejects.toThrow('exit 2')
    expect(error).toHaveBeenCalledWith(`${PROG}: only -c is supported`)
  })
})
