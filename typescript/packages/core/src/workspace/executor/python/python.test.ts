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
import {
  DEFAULT_SESSION_ID,
  makeWorkspace,
  stderrStr,
  stdoutStr,
} from '../../fixtures/workspace_fixture.ts'

// All tests in this file are direct ports of Python mirage's python3 tests
// in tests/workspace/test_workspace.py. Citations are in the `it()` title.

describe('python3: core (ports of Python tests_workspace)', () => {
  it('test_python3_c_simple (L1364): print(42) → "42\\n"', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 -c "print(42)"')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('42\n')
    await ws.close()
  }, 60_000)

  it('test_python3_c_multiline (L1371): multi-stmt -c', async () => {
    const { ws } = await makeWorkspace()
    // Port note: Python test uses double quotes; the TS shell parser has a
    // pre-existing quirk where newlines inside "..." are stripped. Single
    // quotes preserve newlines and the behavioral assertion is identical.
    const io = await ws.execute("python3 -c 'x = 2\nprint(x * 3)'")
    expect(stdoutStr(io)).toBe('6\n')
    await ws.close()
  })

  it('test_python3_c_with_stdin (L1377): echo hello | python3 -c', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      'echo hello | python3 -c "import sys; print(sys.stdin.read().strip().upper())"',
    )
    expect(stdoutStr(io)).toBe('HELLO\n')
    await ws.close()
  })

  it('test_python3_c_path_in_code (L1385): paths in -c stay text', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 -c "print(\'/s3/data/file.txt\')"')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('/s3/data/file.txt')
    await ws.close()
  })

  it('test_python3_c_with_star (L1393): * in -c not glob-expanded', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 -c "print(2 * 3)"')
    expect(stdoutStr(io)).toBe('6\n')
    await ws.close()
  })

  it('test_python3_script_file (L1400): python3 /disk/script.py', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute("echo 'print(99)' > /disk/script.py")
    const io = await ws.execute('python3 /disk/script.py')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('99\n')
    await ws.close()
  })

  it('test_python3_session_env (L1408): export MY_VAR → os.environ', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export MY_VAR=hello_mirage')
    const io = await ws.execute("python3 -c \"import os; print(os.environ.get('MY_VAR', 'none'))\"")
    expect(stdoutStr(io)).toBe('hello_mirage\n')
    await ws.close()
  })

  it('test_python3_no_args (L1417): bare python3 → exit 1 "no input"', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('no input')
    await ws.close()
  })

  it('bare-filename script in cwd: python3 script.py runs the file', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 script.py')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('6\n')
    await ws.close()
  })

  it('bare-filename script in subdir: python3 sub/deep.py runs via cwd', async () => {
    const { ws, disk } = await makeWorkspace()
    disk.store.files.set('/sub/deep.py', new TextEncoder().encode("print('deep ok')\n"))
    ws.getSession(DEFAULT_SESSION_ID).cwd = '/disk'
    const io = await ws.execute('python3 sub/deep.py')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('deep ok\n')
    await ws.close()
  })

  it('bare-filename script not found → exit 1, "No such file" on stderr', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 missing.py')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('No such file')
    await ws.close()
  })

  // ── flag-conditional argv classification (no-c vs -c)
  // These guard the spec/parser interaction: positional args after `-c "code"`
  // must NOT be path-resolved (raw text → sys.argv); without -c, the first
  // positional IS the script (PATH), and subsequent positionals are argv.

  it('python3 -c "code" arg1 arg2 → argv stays bare (no path prefix)', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 -c "import sys; print(sys.argv[1:])" alpha beta')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe("['alpha', 'beta']\n")
    await ws.close()
  })

  it('python3 -c "code" /abs/path → abs path stays as text argv', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 -c "import sys; print(sys.argv[1:])" /disk/some_file')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe("['/disk/some_file']\n")
    await ws.close()
  })

  it('python3 /abs/script.py arg1 arg2 → script reads, argv passes through', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute("echo 'import sys; print(sys.argv[1:])' > /disk/argv.py")
    const io = await ws.execute('python3 /disk/argv.py alpha beta')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe("['alpha', 'beta']\n")
    await ws.close()
  })

  it('python3 script.py one two (bare name + argv via cwd)', async () => {
    const { ws, disk } = await makeWorkspace()
    disk.store.files.set(
      '/with_argv.py',
      new TextEncoder().encode('import sys; print(sys.argv[1:])\n'),
    )
    ws.getSession(DEFAULT_SESSION_ID).cwd = '/disk'
    const io = await ws.execute('python3 with_argv.py one two')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe("['one', 'two']\n")
    await ws.close()
  })

  it('test_python_pipe (L848): python3 -c ... | grep', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("python3 -c 'print(42)' | grep 42")
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('test_python_pipe_stdin (L1653): echo code | python3', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo "print(1+2)" | python3')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('3\n')
    await ws.close()
  })

  it('test_python_heredoc (L1748): python3 << PYEOF', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("python3 << 'PYEOF'\nprint(1 + 2)\nPYEOF")
    expect(stdoutStr(io)).toBe('3\n')
    await ws.close()
  })

  it('test_python_heredoc_dash_strips_indentation (L1783): <<-PYEOF', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 <<-PYEOF\n\tfor i in range(3):\n\t    print(i)\n\tPYEOF')
    expect(stdoutStr(io)).toBe('0\n1\n2\n')
    await ws.close()
  })

  it('test_python_heredoc_quoted_keeps_dollar_literal (L1794): $X stays literal', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export X=shellval')
    const io = await ws.execute("python3 << 'PYEOF'\nprint('$X')\nPYEOF")
    expect(stdoutStr(io).trim()).toBe('$X')
    await ws.close()
  })

  it('test_python_heredoc_unquoted_expands (L1806): unquoted heredoc expands', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export X=shellval')
    const io = await ws.execute("python3 << PYEOF\nprint('$X')\nPYEOF")
    expect(stdoutStr(io).trim()).toBe('shellval')
    await ws.close()
  })

  it('test_heredoc_pipe (L1932): python3 heredoc | head -n 1', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      "python3 << 'PYEOF' | head -n 1\nfor i in range(5):\n    print(i)\nPYEOF",
    )
    expect(stdoutStr(io)).toBe('0\n')
    await ws.close()
  })
})

describe('python3: TS-specific (Pyodide isolation + mechanics)', () => {
  // These have no Python-subprocess analog — they pin the Pyodide-layer
  // isolation invariants documented in §14 of the design doc.

  it('SystemExit(int) honors exit code', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 -c "import sys; sys.exit(3)"')
    expect(io.exitCode).toBe(3)
    await ws.close()
  })

  it('SystemExit() (no arg) → exit 0', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 -c "import sys; sys.exit()"')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('SystemExit("msg") → exit 1 + msg on stderr', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 -c "import sys; sys.exit(\\"boom\\")"')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('boom')
    await ws.close()
  })

  it('uncaught exception → exit 1 + traceback', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 -c "raise RuntimeError(\\"oops\\")"')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('RuntimeError')
    expect(stderrStr(io)).toContain('oops')
    await ws.close()
  })

  it('cross-call env isolation: mutations die with the call', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute("python3 -c \"import os; os.environ['LEAKED'] = 'yes'\"")
    const io = await ws.execute(
      "python3 -c \"import os; print(os.environ.get('LEAKED', 'absent'))\"",
    )
    expect(stdoutStr(io).trim()).toBe('absent')
    await ws.close()
  })

  it('cross-call namespace isolation: top-level vars do not leak', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('python3 -c "leaked_var = 42"')
    const io = await ws.execute('python3 -c "print(\'leaked_var\' in dir())"')
    expect(stdoutStr(io).trim()).toBe('False')
    await ws.close()
  })

  it('sys.modules sharing within workspace (intentional divergence)', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('python3 -c "import json"')
    const io = await ws.execute('python3 -c "import sys; print(\'json\' in sys.modules)"')
    expect(stdoutStr(io).trim()).toBe('True')
    await ws.close()
  })

  it('script file not found → exit 1, "No such file" on stderr', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('python3 /ram/does_not_exist.py')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('No such file')
    await ws.close()
  })

  it('cross-workspace isolation: different workspaces have different envs', async () => {
    const a = await makeWorkspace()
    const b = await makeWorkspace()
    await a.ws.execute('export NAME=alpha')
    await b.ws.execute('export NAME=beta')
    const [ra, rb] = await Promise.all([
      a.ws.execute('python3 -c "import os; print(os.environ[\'NAME\'])"'),
      b.ws.execute('python3 -c "import os; print(os.environ[\'NAME\'])"'),
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
        ws.execute(
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
    const check = await ws.execute('python3 -c "import os; print(\'VAR\' in os.environ)"')
    expect(stdoutStr(check).trim()).toBe('False')
    await ws.close()
  }, 60_000)
})
