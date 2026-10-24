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
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Context } from '@struktoai/mirage-core/commands/config'
import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import type { Program, RunResult } from '@struktoai/mirage-core/runtime/types'
import type { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { DiskVFS } from '../../../vfs/disk/disk.ts'
import { Workspace } from '../../../workspace.ts'
import { LocalRuntime } from './runtime.ts'

const DEC = new TextDecoder()

function interpret(rt: LocalRuntime, program: Partial<Program>, fields: Partial<Context> = {}) {
  const ctx = { stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/'), ...fields }
  return rt.interpret(undefined, { code: '', args: [], stdin: null, ...program }, ctx)
}

function runProcess(
  rt: LocalRuntime,
  argv: readonly string[],
  cwd: string,
  stdin: Uint8Array | null = null,
) {
  const ctx = { stdin, flags: {}, cwd: PathSpec.fromStrPath(cwd) }
  return rt.runProcess(undefined, [], [...argv], ctx, undefined)
}

describe('LocalRuntime', () => {
  it('waits for an exited native child without requiring stdin to close', async () => {
    const ws = new Workspace(
      {},
      { mode: MountMode.EXEC, runtimes: [new LocalRuntime({ captures: ['uname'] }), 'workspace'] },
    )
    try {
      const child = ws.spawn({ argv: ['uname'] })
      expect(await child.wait()).toMatchObject({ exitCode: 0 })
      expect(ws.processes.live()).toHaveLength(0)
    } finally {
      await ws.close()
    }
  })

  it.each([
    ['dir/py/list.py', 'seed.txt\nsub\n'],
    ['path/py/stat.py', 'file 5 32768\ndir 16384\nmissing\n'],
    ['dir/py/glob.py', 'seed.txt\nsub/inner.txt\n'],
  ])('runs the shared %s filesystem fixture', async (fixture, expected) => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-local-fs-'))
    const rt = new LocalRuntime()
    try {
      await writeFile(join(dir, 'seed.txt'), 'seed\n')
      await mkdir(join(dir, 'sub'))
      await writeFile(join(dir, 'sub/inner.txt'), 'inner\n')
      const code = await readFile(
        new URL(`../../../../../../../integ/fixtures/runtime/${fixture}`, import.meta.url),
        'utf8',
      )
      const result = await interpret(rt, { code }, { env: { MIRAGE_TEST_ROOT: dir } })
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
      const result = await interpret(rt, {
        code: "from __future__ import annotations\nimport sys\nprint(argv)\nprint(stdin is None, len(stdin or b''), sys.stdin.buffer.read() == (stdin or b''))",
        prog: 'pager',
        args: ['one'],
        scriptCli: true,
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
    'gives the version process none of the session environment in %s mode',
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
      expect(expected).toMatchObject({ MIRAGE_TEST_VERSION_ENV: null })
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

  // An empty PATH entry is the current directory; the name resolves to an
  // absolute path, since the program's environment has no PATH to find it.
  it('runs a bare home found through an empty PATH entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-local-path-'))
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim()
    const probe = join(dir, 'mirage-probe')
    await writeFile(probe, `#!${python}\nprint('probe')\n`)
    await chmod(probe, 0o755)
    vi.stubEnv('PATH', delimiter)
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    try {
      const rt = new LocalRuntime({ config: { home: 'mirage-probe' } })
      cwd.mockRestore()
      const result = await rt.version({})
      expect(DEC.decode(result.stdout)).toBe('probe\n')
      await rt.close()
    } finally {
      cwd.mockRestore()
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A configured path is read from the directory the entry is built in,
  // as the Python twin makes it absolute.
  it('runs a home configured as a relative path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-local-relative-'))
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim()
    await mkdir(join(dir, 'bin'))
    await symlink(python, join(dir, 'bin', 'python'))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    try {
      const rt = new LocalRuntime({ config: { home: './bin/python' } })
      cwd.mockRestore()
      const result = await interpret(rt, { code: 'print("relative")' })
      expect(DEC.decode(result.stdout)).toBe('relative\n')
      await rt.close()
    } finally {
      cwd.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A run still finding its interpreter when the runtime closes starts
  // nothing, so no child outlives the close.
  it('starts no interpreter once the runtime has closed', async () => {
    const rt = new LocalRuntime()
    const run = interpret(rt, { code: 'import time; time.sleep(30)' })
    await rt.close()
    await expect(run).rejects.toThrow('local: the runtime is closed')
  })

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
      const control = await interpret(rt, { code: 'pass' }, { env })
      expect(control.exitCode).toBe(0)
      expect(await readFile(marker, 'utf8')).toBe('ran')
    } finally {
      await ws.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs code on the host python with argv, stdin and env', async () => {
    const rt = new LocalRuntime()
    const result = await interpret(
      rt,
      {
        code: 'import os, sys; print(sys.argv[1:], sys.stdin.read(), os.environ["K"])',
        args: ['alpha', 'beta'],
        stdin: new TextEncoder().encode('piped'),
      },
      { env: { K: 'V' } },
    )
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe("['alpha', 'beta'] piped V\n")
  })

  it('gives the program none of the host environment', async () => {
    vi.stubEnv('MIRAGE_TEST_HOST_ONLY', 'host')
    const rt = new LocalRuntime({ config: { env: { MIRAGE_TEST_CONFIG: 'config' } } })
    try {
      const result = await interpret(
        rt,
        {
          code:
            "import os; print(os.environ.get('MIRAGE_TEST_HOST_ONLY'), " +
            "os.environ['MIRAGE_TEST_CONFIG'], os.environ['MY_VAR'])",
        },
        { env: { MY_VAR: 'session' } },
      )
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('None config session\n')
    } finally {
      vi.unstubAllEnvs()
      await rt.close()
    }
  })

  it('hands the init switches to the host interpreter', async () => {
    const rt = new LocalRuntime()
    const result = await interpret(
      rt,
      { code: 'import sys; print(sys.flags.optimize, sys.dont_write_bytecode, sys.warnoptions)' },
      { flags: { O: 2, B: true, W: ['ignore'] } },
    )
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('')
    expect(DEC.decode(result.stdout)).toBe("2 True ['ignore']\n")
  })

  it('strips asserts under -O, with no notice', async () => {
    // Mirrors Python's test_dash_o_strips_asserts_on_a_cpython_runtime.
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: [new LocalRuntime(), 'workspace'] },
    )
    try {
      const io = await ws.shell(`python3 -O -c 'assert False, "boom"; print("ok")'`)
      expect(DEC.decode(io.stderr)).toBe('')
      expect(io.exitCode).toBe(0)
      expect(DEC.decode(io.stdout)).toBe('ok\n')
    } finally {
      await ws.close()
    }
  })

  it('names a script after its file, as CPython does', async () => {
    const rt = new LocalRuntime()
    const result = await interpret(
      rt,
      {
        code: 'import sys\nprint(sys.argv[0], __file__)\nraise SystemExit(sys.argv[1])\n',
        args: ['bye'],
        prog: './s.py',
        scriptPath: new PathSpec({
          virtual: '/w/s.py',
          directory: '/w/',
          vfsPath: 'w/s.py',
          rawPath: './s.py',
        }),
      },
      { cwd: PathSpec.fromStrPath('/w') },
    )
    expect(DEC.decode(result.stdout)).toBe('./s.py /w/./s.py\n')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('bye\n')
    expect(result.exitCode).toBe(1)
  })

  it('reports the interpreter exit code and stderr', async () => {
    const rt = new LocalRuntime()
    const result = await interpret(rt, { code: 'import sys; sys.exit(3)' })
    expect(result.exitCode).toBe(3)
  })

  it('a missing interpreter fails at construction with the config hint', () => {
    expect(() => new LocalRuntime({ config: { home: '/nope/python-does-not-exist' } })).toThrow(
      'local python interpreter not found',
    )
  })

  it('an aborted signal kills the interpreter (limit timeout path)', async () => {
    const rt = new LocalRuntime()
    const ctl = new AbortController()
    const started = Date.now()
    const pending = interpret(rt, { code: 'import time; time.sleep(60)' }, { signal: ctl.signal })
    setTimeout(() => {
      ctl.abort()
    }, 100)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('stdin larger than the pipe buffer to an early-exiting program is not an error', async () => {
    const rt = new LocalRuntime()
    const result = await interpret(rt, { code: 'pass', stdin: new Uint8Array(4 * 1024 * 1024) })
    expect(result.exitCode).toBe(0)
  })

  it('close() kills any child still running', async () => {
    const rt = new LocalRuntime()
    const pending = interpret(rt, { code: 'import time; time.sleep(60)' })
    await new Promise((r) => setTimeout(r, 100))
    await rt.close()
    const result = await pending
    expect(result.exitCode).not.toBe(0)
  })

  it.each([
    [['cksum'], '/', 0, '2352138605 2\n', ''],
    [['no-such-program-xyz'], '/', 127, '', 'no-such-program-xyz: command not found\n'],
    [
      ['cksum'],
      '/no/such/dir',
      126,
      '',
      'cksum: the working directory /no/such/dir is not on this host\n',
    ],
  ] as const)(
    'runs a captured program on the host: %j in %s',
    async (argv, cwd, exitCode, stdout, stderr) => {
      const rt = new LocalRuntime({ captures: ['python3', '@external'] })
      try {
        const result = await runProcess(rt, argv, cwd, new TextEncoder().encode('hi'))
        expect([
          result.exitCode,
          DEC.decode(result.stdout),
          DEC.decode(result.stderr ?? new Uint8Array()),
        ]).toEqual([exitCode, stdout, stderr])
      } finally {
        await rt.close()
      }
    },
  )

  it('runs a program named by a relative path from the cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-local-'))
    const tool = join(dir, 'mirage-tool')
    await writeFile(tool, '#!/bin/sh\necho tool\n')
    await chmod(tool, 0o755)
    const rt = new LocalRuntime({ captures: ['@external'] })
    try {
      const result = await runProcess(rt, ['./mirage-tool'], dir)
      expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'tool\n'])
    } finally {
      await rt.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['./missing', 127, './missing: No such file or directory\n'],
    ['./plain', 126, './plain: Permission denied\n'],
    ['./sub', 126, './sub: Is a directory\n'],
  ])('answers %s as the shell would', async (name, exitCode, stderr) => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-local-'))
    await writeFile(join(dir, 'plain'), '#!/bin/sh\necho hi\n')
    await mkdir(join(dir, 'sub'))
    const rt = new LocalRuntime({ captures: ['@external'] })
    try {
      const result = await runProcess(rt, [name], dir)
      expect([result.exitCode, DEC.decode(result.stderr ?? new Uint8Array())]).toEqual([
        exitCode,
        stderr,
      ])
    } finally {
      await rt.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('follows a .. past a symlink in a program path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-local-'))
    await mkdir(join(dir, 'opt', 'build'), { recursive: true })
    const tool = join(dir, 'opt', 'mirage-tool')
    await writeFile(tool, '#!/bin/sh\necho opt\n')
    await chmod(tool, 0o755)
    await mkdir(join(dir, 'work'))
    await symlink(join(dir, 'opt', 'build'), join(dir, 'work', 'link'))
    const rt = new LocalRuntime({ captures: ['@external'] })
    try {
      const result = await runProcess(rt, ['link/../mirage-tool'], join(dir, 'work'))
      expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'opt\n'])
    } finally {
      await rt.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails a program that cannot start as the shell would', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-local-'))
    const tool = join(dir, 'mirage-broken')
    await writeFile(tool, '#!/no/such/interpreter\n')
    await chmod(tool, 0o755)
    const rt = new LocalRuntime({ captures: ['@external'] })
    vi.stubEnv('PATH', dir)
    try {
      const result = await runProcess(rt, ['mirage-broken'], dir)
      expect([result.exitCode, DEC.decode(result.stderr ?? new Uint8Array())]).toEqual([
        126,
        'mirage-broken: cannot execute: No such file or directory\n',
      ])
    } finally {
      vi.unstubAllEnvs()
      await rt.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('finds a program by its PATHEXT suffix on Windows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-local-'))
    const tool = join(dir, 'mirage-tool.EXE')
    await writeFile(tool, '#!/bin/sh\necho tool\n')
    await chmod(tool, 0o755)
    const rt = new LocalRuntime({ captures: ['@external'] })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (platform === undefined) throw new Error('process.platform has no descriptor')
    vi.stubEnv('PATH', dir)
    vi.stubEnv('PATHEXT', '.COM;.EXE')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      const result = await runProcess(rt, ['mirage-tool'], dir)
      expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'tool\n'])
    } finally {
      Object.defineProperty(process, 'platform', platform)
      vi.unstubAllEnvs()
      await rt.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('registers under the local name', () => {
    expect(buildRuntime('local')).toBeInstanceOf(LocalRuntime)
  })
})

it.each(["yes | perl -ne 'print; exit'", 'perl -e \'$|=1; print "y\\n" while 1\' | head -1'])(
  'streams infinite pipes and closes children: %s',
  async (line) => {
    const rt = new LocalRuntime({ captures: ['@external'] })
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: [rt, 'workspace'] },
    )
    try {
      const result = await ws.shell(line)
      expect(result.exitCode, DEC.decode(result.stderr)).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('y\n')
    } finally {
      await ws.close()
    }
  },
  5000,
)

it.skipIf(process.platform === 'win32')(
  'shows a file the program makes in the next listing',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mirage-local-')))
    const ws = new Workspace(
      { [root]: new DiskVFS({ root }) },
      { mode: MountMode.EXEC, runtimes: [new LocalRuntime(), 'workspace'] },
    )
    try {
      expect(DEC.decode((await ws.shell(`ls ${root}`)).stdout)).toBe('')
      const made = await ws.shell(`python3 -c "open('${root}/made.txt', 'w').write('x')"`)
      expect(made.exitCode).toBe(0)
      expect(DEC.decode((await ws.shell(`ls ${root}`)).stdout)).toBe('made.txt\n')
    } finally {
      await ws.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

// A local runtime that records the programs it would run.
class RecordingLocalRuntime extends LocalRuntime {
  readonly programs: Program[] = []

  override interpret(_engine: undefined, program: Program): Promise<RunResult> {
    this.programs.push(program)
    return Promise.resolve({ stdout: new TextEncoder().encode('ran\n'), stderr: null, exitCode: 0 })
  }
}

const RESTRICTIONS: SessionProfile[] = [
  { paths: { hide: ['/data/secret'] } },
  { commands: { deny: [{ paths: ['/data/secret'], reason: 'x' }] } },
  { mounts: new Map([['/data', { mode: MountMode.READ }]]) },
]

it.each(RESTRICTIONS)('refuses every program under a session restriction', async (profile) => {
  const runtime = new RecordingLocalRuntime()
  const root = await mkdtemp(join(tmpdir(), 'mirage-local-'))
  const ws = new Workspace(
    { '/data': new DiskVFS({ root }) },
    { mode: MountMode.EXEC, profiles: { agent: profile }, runtimes: [runtime, 'workspace'] },
  )
  try {
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 -c pass')
    expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
      126,
      '',
      'local: Permission denied\n',
    ])
    expect(runtime.programs).toEqual([])
    const other = await ws.session('other')
    expect(DEC.decode((await other.shell('python3 -c pass')).stdout)).toBe('ran\n')
  } finally {
    await ws.close()
    await rm(root, { recursive: true, force: true })
  }
})
