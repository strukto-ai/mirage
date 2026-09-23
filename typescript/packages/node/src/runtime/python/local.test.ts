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

import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '../../workspace.ts'
import { LocalRuntime } from './local.ts'

const DEC = new TextDecoder()

describe('LocalRuntime', () => {
  it.each([
    ['list', 'seed.txt\nsub\n'],
    ['stat', 'file 5 32768\ndir 16384\nmissing\n'],
    ['glob', 'seed.txt\nsub/inner.txt\n'],
  ])('runs the shared %s filesystem fixture', async (operation, expected) => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-local-fs-'))
    const rt = new LocalRuntime()
    try {
      await writeFile(join(dir, 'seed.txt'), 'seed\n')
      await mkdir(join(dir, 'sub'))
      await writeFile(join(dir, 'sub/inner.txt'), 'inner\n')
      const code = await readFile(
        new URL(`../../../../../../integ/fixtures/runtime/fs/py/${operation}.py`, import.meta.url),
        'utf8',
      )
      const result = await rt.run({ code, args: [], env: { MIRAGE_TEST_ROOT: dir }, stdin: null })
      expect(result.exitCode, DEC.decode(result.stderr ?? new Uint8Array())).toBe(0)
      expect(DEC.decode(result.stdout)).toBe(expected)
      expect(result.stderr).toBeNull()
    } finally {
      await rt.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([null, new Uint8Array(), new Uint8Array(300_000).fill(120)])(
    'keeps script-CLI input off the process argv',
    async (stdin) => {
      const rt = new LocalRuntime()
      const result = await rt.run({
        code: "from __future__ import annotations\nimport sys\nprint(argv)\nprint(stdin is None, len(stdin or b''), sys.stdin.buffer.read() == (stdin or b''))",
        prog: 'pager',
        args: ['one'],
        scriptCli: true,
        env: {},
        stdin,
      })
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe(
        `['pager', 'one']\n${stdin === null ? 'True' : 'False'} ${String(stdin?.length ?? 0)} True\n`,
      )
      await rt.close()
    },
  )

  it.each([MountMode.READ, MountMode.WRITE, MountMode.EXEC])(
    'uses only the host environment for the version process in %s mode',
    async (mode) => {
      const dir = await mkdtemp(join(tmpdir(), 'mirage-local-version-env-'))
      vi.stubEnv('MIRAGE_TEST_VERSION_ENV', 'host')
      const session = {
        LD_PRELOAD: join(dir, 'session.so'),
        LD_LIBRARY_PATH: dir,
        DYLD_INSERT_LIBRARIES: join(dir, 'session.dylib'),
        DYLD_LIBRARY_PATH: dir,
        PATH: dir,
        MIRAGE_TEST_VERSION_ENV: 'session',
      }
      const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf8',
      }).trim()
      const probe = join(dir, 'python-probe')
      await writeFile(
        probe,
        `#!${python}\nimport json, os\nprint(json.dumps({k: os.environ.get(k) for k in ${JSON.stringify(Object.keys(session))}}))\n`,
      )
      await chmod(probe, 0o755)
      const rt = new LocalRuntime({ config: { home: probe } })
      const baseline = await rt.version({})
      const expected: unknown = JSON.parse(DEC.decode(baseline.stdout))
      expect(expected).toMatchObject({ MIRAGE_TEST_VERSION_ENV: 'host' })
      const ws = new Workspace({ '/': new RAMVFS() }, { mode, runtimes: [rt, 'workspace'] })
      try {
        for (const line of ['python --version', 'python3 -V', 'python -VV']) {
          const io = await ws.shell(line, { env: session })
          expect(io.exitCode).toBe(0)
          expect(JSON.parse(DEC.decode(io.stdout))).toEqual(expected)
          expect(DEC.decode(io.stderr)).toBe('')
        }
      } finally {
        await ws.close()
        vi.unstubAllEnvs()
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  it('reports versions in READ mode without running Python startup code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-local-version-'))
    const marker = join(dir, 'startup-ran')
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim()
    const expected = execFileSync(python, ['--version'], { encoding: 'utf8' })
    await writeFile(
      join(dir, 'sitecustomize.py'),
      `open(${JSON.stringify(marker)}, 'w').write('ran')\n`,
    )
    const env = { PYTHONPATH: dir }
    const rt = new LocalRuntime({ config: { home: python } })
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.READ, runtimes: [rt, 'workspace'] },
    )
    try {
      for (const line of ['python --version', 'python3 -V', 'python -VV']) {
        const io = await ws.shell(line, { env })
        expect(io.exitCode).toBe(0)
        expect(DEC.decode(io.stdout)).toBe(expected)
        expect(DEC.decode(io.stderr)).toBe('')
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      const refused = await ws.shell("python -c 'pass'", { env })
      expect(refused.exitCode).toBe(126)
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      const control = await rt.run({ code: 'pass', args: [], stdin: null, env })
      expect(control.exitCode).toBe(0)
      expect(await readFile(marker, 'utf8')).toBe('ran')
    } finally {
      await ws.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs code on the host python with argv, stdin and env', async () => {
    const rt = new LocalRuntime()
    const result = await rt.run({
      code: 'import os, sys; print(sys.argv[1:], sys.stdin.read(), os.environ["K"])',
      args: ['alpha', 'beta'],
      stdin: new TextEncoder().encode('piped'),
      env: { K: 'V' },
      flags: {},
    })
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe("['alpha', 'beta'] piped V\n")
  })

  it('reports the interpreter exit code and stderr', async () => {
    const rt = new LocalRuntime()
    const result = await rt.run({
      code: 'import sys; sys.exit(3)',
      args: [],
      stdin: null,
      env: {},
      flags: {},
    })
    expect(result.exitCode).toBe(3)
  })

  it('a missing interpreter fails with the config hint', async () => {
    const rt = new LocalRuntime({ config: { home: '/nope/python-does-not-exist' } })
    await expect(
      rt.run({ code: 'print(1)', args: [], stdin: null, env: {}, flags: {} }),
    ).rejects.toThrow(/local python interpreter not found/)
  })

  it('an aborted signal kills the interpreter (limit timeout path)', async () => {
    const rt = new LocalRuntime()
    const ctl = new AbortController()
    const started = Date.now()
    const pending = rt.run({
      code: 'import time; time.sleep(60)',
      args: [],
      stdin: null,
      env: {},
      flags: {},
      signal: ctl.signal,
    })
    setTimeout(() => {
      ctl.abort()
    }, 100)
    const result = await pending
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.exitCode).not.toBe(0)
  })

  it('stdin larger than the pipe buffer to an early-exiting program is not an error', async () => {
    const rt = new LocalRuntime()
    const result = await rt.run({
      code: 'pass',
      args: [],
      stdin: new Uint8Array(4 * 1024 * 1024),
      env: {},
      flags: {},
    })
    expect(result.exitCode).toBe(0)
  })

  it('close() kills any child still running', async () => {
    const rt = new LocalRuntime()
    const pending = rt.run({
      code: 'import time; time.sleep(60)',
      args: [],
      stdin: null,
      env: {},
      flags: {},
    })
    await new Promise((r) => setTimeout(r, 100))
    await rt.close()
    const result = await pending
    expect(result.exitCode).not.toBe(0)
  })

  it('registers under the local name', () => {
    expect(buildRuntime('local')).toBeInstanceOf(LocalRuntime)
  })
})
