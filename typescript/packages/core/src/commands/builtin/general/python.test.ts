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

import { describe, expect, it } from 'vitest'
import { parseSessionProfile } from '../../../policy/profile.ts'
import { MontyRuntime } from '../../../runtime/python/monty/runtime.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import {
  getTestParser,
  makeWorkspace,
  stderrStr,
  stdoutStr,
} from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

const GUARDED = parseSessionProfile({
  commands: { deny: [{ reason: 'protected', commands: { python3: ['/secret.py'] } }] },
})

async function guarded(): Promise<Workspace> {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      shellParser: await getTestParser(),
      runtimes: [new MontyRuntime(), 'workspace'],
      profiles: { default: GUARDED },
    },
  )
}

describe('python3: a rule on the script', () => {
  it.each([['python3 ./secret.py', './secret.py']])(
    'reads %s however it is typed',
    async (line, shown) => {
      const ws = await guarded()
      try {
        await ws.shell("printf 'print(1)\\n' > /secret.py")
        const io = await ws.shell(line)
        expect(io.exitCode).toBe(1)
        expect(stdoutStr(io)).toBe('')
        expect(stderrStr(io)).toBe(`python3: ${shown}: Permission denied\n`)
        expect(io.refusal?.reason).toBe('protected')
      } finally {
        await ws.close()
      }
    },
  )

  it.each(["python3 -c 'print(argv[1:])' secret.py"])(
    'keeps the words after the script as its argv: %s',
    async (line) => {
      const ws = await guarded()
      try {
        await ws.shell("printf 'print(argv[1:])\\n' > /s.py")
        const io = await ws.shell(line)
        expect(io.exitCode).toBe(0)
        expect(stdoutStr(io)).toBe("['secret.py']\n")
      } finally {
        await ws.close()
      }
    },
  )
})

describe('python3: the program argv and its own file', { timeout: 60000 }, () => {
  async function seeded(): Promise<Awaited<ReturnType<typeof makeWorkspace>>> {
    const made = await makeWorkspace()
    await made.ws.shell('mkdir -p /disk/app /disk/data')
    await made.ws.shell("printf 'import sys\\nprint(sys.argv[1:])\\n' > /disk/app/argv.py")
    await made.ws.shell("printf 'print(__file__)\\n' > /disk/app/file.py")
    await made.ws.shell(
      "printf 'import sys\\nprint(repr(sys.path[0]))\\nimport helper\\n' > /disk/app/imp.py",
    )
    await made.ws.shell('echo \'print("helper imported")\' > /disk/app/helper.py')
    await made.ws.shell('echo x > /disk/data/in.csv')
    return made
  }

  it.each([
    [
      'cd /disk && python3 app/argv.py data/in.csv data/in ./data/in.csv /disk/data/',
      "['data/in.csv', 'data/in', './data/in.csv', '/disk/data/']",
    ],
    [
      'cd /ram && python3 /disk/app/argv.py --input /ram/notes.txt --out=/ram/o.csv',
      "['--input', '/ram/notes.txt', '--out=/ram/o.csv']",
    ],
  ])('hands a path-shaped word over as typed: %s', async (line, argv) => {
    // bash hands the words over as typed, globs expanded, and the program
    // opens what it likes: a word naming another mount is no second mount
    // for the line.
    const { ws } = await seeded()
    try {
      const io = await ws.shell(line)
      expect(stderrStr(io)).toBe('')
      expect(io.exitCode).toBe(0)
      expect(stdoutStr(io)).toBe(`${argv}\n`)
    } finally {
      await ws.close()
    }
  })

  it.each([['cd /disk && python3 app/file.py', '/disk/app/file.py']])(
    'binds __file__ the way CPython names the file: %s',
    async (line, file) => {
      // CPython 3.13.5: the operand made absolute as typed, never
      // normalized, and <stdin> for a program piped in.
      const { ws } = await seeded()
      try {
        const io = await ws.shell(line)
        expect(stderrStr(io)).toBe('')
        expect(stdoutStr(io)).toBe(`${file}\n`)
      } finally {
        await ws.close()
      }
    },
  )

  it('honors -P: neither the script directory nor the working directory', async () => {
    const { ws } = await seeded()
    try {
      const io = await ws.shell('cd /disk/app && python3 -P imp.py')
      expect(io.exitCode).toBe(1)
      expect(stdoutStr(io)).not.toContain("''")
      expect(stdoutStr(io)).not.toContain("'/disk/app'")
      expect(stderrStr(io)).toContain("ModuleNotFoundError: No module named 'helper'")
      expect(stderrStr(io)).not.toContain('-P is ignored')
    } finally {
      await ws.close()
    }
  })
})

// All tests in this file are direct ports of Python mirage's python3 tests
// in tests/workspace/test_workspace.py. Citations are in the `it()` title.

describe('python3: core (ports of Python tests_workspace)', { timeout: 30000 }, () => {
  it('reports the Pyodide guest version through every version spelling', async () => {
    const { ws } = await makeWorkspace()
    try {
      const guest = await ws.shell("python3 -c 'import sys; print(sys.version.split()[0])'")
      expect(guest.exitCode).toBe(0)
      const expected = `Python ${stdoutStr(guest).trim()} (pyodide)\n`
      for (const line of ['python --version', 'python3 -VV']) {
        const io = await ws.shell(line)
        expect(io.exitCode).toBe(0)
        expect(stdoutStr(io)).toBe(expected)
        expect(stderrStr(io)).toBe('')
      }
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('passes a program its own --version argument', async () => {
    const { ws } = await makeWorkspace()
    try {
      await ws.shell("echo 'import sys; print(sys.argv[-1])' > /ram/version.py")
      const io = await ws.shell('python3 /ram/version.py --version')
      expect(io.exitCode).toBe(0)
      expect(stdoutStr(io)).toBe('--version\n')
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('test_python3_no_args (L1417): bare python3 → exit 1 "no input"', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('python3')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('no input')
    await ws.close()
  })

  it('bare-filename script not found → exit 1, "No such file" on stderr', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('python3 missing.py')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('No such file')
    await ws.close()
  })
})

describe('python3: TS-specific (Pyodide isolation + mechanics)', { timeout: 30000 }, () => {
  // These have no Python-subprocess analog — they pin the Pyodide-layer
  // isolation invariants documented in §14 of the design doc.

  it('SystemExit() (no arg) → exit 0', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('python3 -c "import sys; sys.exit()"')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('SystemExit("msg") → exit 1 + msg on stderr', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('python3 -c "import sys; sys.exit(\\"boom\\")"')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('boom')
    await ws.close()
  })

  it('cross-call env isolation: mutations die with the call', async () => {
    const { ws } = await makeWorkspace()
    await ws.shell("python3 -c \"import os; os.environ['LEAKED'] = 'yes'\"")
    const io = await ws.shell("python3 -c \"import os; print(os.environ.get('LEAKED', 'absent'))\"")
    expect(stdoutStr(io).trim()).toBe('absent')
    await ws.close()
  })

  it('cross-call namespace isolation: top-level vars do not leak', async () => {
    const { ws } = await makeWorkspace()
    await ws.shell('python3 -c "leaked_var = 42"')
    const io = await ws.shell('python3 -c "print(\'leaked_var\' in dir())"')
    expect(stdoutStr(io).trim()).toBe('False')
    await ws.close()
  })

  it('sys.modules entries do not leak between commands in one workspace', async () => {
    const { ws } = await makeWorkspace()
    await ws.shell(
      "python3 -c \"import sys, types; sys.modules['mirage_test_module'] = types.ModuleType('mirage_test_module')\"",
    )
    const io = await ws.shell(
      'python3 -c "import sys; print(\'mirage_test_module\' in sys.modules)"',
    )
    expect(stdoutStr(io).trim()).toBe('False')
    await ws.close()
  })

  it('cross-workspace isolation: different workspaces have different envs', async () => {
    const a = await makeWorkspace()
    const b = await makeWorkspace()
    await a.ws.shell('export NAME=alpha')
    await b.ws.shell('export NAME=beta')
    const [ra, rb] = await Promise.all([
      a.ws.shell('python3 -c "import os; print(os.environ[\'NAME\'])"'),
      b.ws.shell('python3 -c "import os; print(os.environ[\'NAME\'])"'),
    ])
    expect(stdoutStr(ra).trim()).toBe('alpha')
    expect(stdoutStr(rb).trim()).toBe('beta')
    await a.ws.close()
    await b.ws.close()
  }, 30000)

  it('concurrent calls — each sees its own os.environ mutations atomically', async () => {
    const { ws } = await makeWorkspace()
    // Each python3 call sets and reads os.environ['VAR'] internally — no
    // session-level export. The JS queue + Python try/finally guarantees
    // that call N's snapshot/set/read/restore is atomic w.r.t. call N+1.
    // Without the queue, two concurrent calls would race on os.environ.
    const N = 8
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ws.shell(
          `python3 -c "import os; os.environ['VAR'] = '${String(i)}'; ` +
            `import time; print(os.environ['VAR'])"`,
        ),
      ),
    )
    for (let i = 0; i < N; i++) {
      const r = results[i]
      if (r === undefined) throw new Error(`missing result at index ${String(i)}`)
      expect(stdoutStr(r).trim()).toBe(String(i))
    }
    // After all calls, os.environ['VAR'] should NOT leak (restored by finally).
    const check = await ws.shell('python3 -c "import os; print(\'VAR\' in os.environ)"')
    expect(stdoutStr(check).trim()).toBe('False')
    await ws.close()
  }, 60_000)

  it('a shadowing function receives the words as typed', async () => {
    // bash's own rule: a function of the same name takes the line. It has
    // no CPython option table, so the `--` the interpreter's handoff would
    // need must not be inserted into its arguments.
    const { ws } = await makeWorkspace()
    await ws.shell('python3() { echo "$@"; }')
    const io = await ws.shell('python3 -c payload -u x')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('-c payload -u x\n')
    await ws.close()
  })

  it('command bypasses the function and restores the handoff', async () => {
    // `command` masks the function for its inner run, so the interpreter
    // is what runs and -u belongs to the program again.
    const { ws } = await makeWorkspace()
    await ws.shell('python3() { echo "$@"; }')
    const io = await ws.shell('command python3 -c "import sys; print(sys.argv)" -u x')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe("['-c', '-u', 'x']\n")
    await ws.close()
  }, 60_000)

  it('an invalid -W filter is reported and the program still runs', async () => {
    // CPython names a bad filter at startup and runs the program anyway;
    // aborting would kill a line every other runtime completes.
    const { ws } = await makeWorkspace()
    const io = await ws.shell('python3 -W nonsense -c "print(42)"')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('42\n')
    expect(stderrStr(io)).toBe("Invalid -W option ignored: invalid action: 'nonsense'\n")
    await ws.close()
  }, 60_000)

  it('a known -X name is reported as unhonored', async () => {
    // -X dev's real effect is read out of sys.flags, which is read-only,
    // so populating sys._xoptions is all this engine can do for it.
    const { ws } = await makeWorkspace()
    const io = await ws.shell('python3 -X dev -c "print(7)"')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('7\n')
    expect(stderrStr(io)).toContain("-X dev is ignored by the 'pyodide' runtime")
    await ws.close()
  }, 60_000)

  it('an arbitrary -X name lands in sys._xoptions in silence', async () => {
    // On CPython it does nothing but land in the dict either.
    const { ws } = await makeWorkspace()
    const io = await ws.shell('python3 -X nosuchopt -c "import sys; print(sys._xoptions)"')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe("{'nosuchopt': True}\n")
    expect(stderrStr(io)).toBe('')
    await ws.close()
  }, 60_000)

  it('unsetting the function restores the handoff', async () => {
    const { ws } = await makeWorkspace()
    await ws.shell('python3() { echo "$@"; }')
    await ws.shell('unset -f python3')
    const io = await ws.shell('python3 -c "import sys; print(sys.argv)" -u x')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe("['-c', '-u', 'x']\n")
    await ws.close()
  }, 60_000)
})
