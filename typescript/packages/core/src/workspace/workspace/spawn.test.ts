import { shellQuote } from '../../utils/quote.ts'
import { MontyRuntime } from '../../runtime/python/monty/runtime.ts'
import { PyodideRuntime } from '../../runtime/python/pyodide/runtime.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { beforeAll, expect, it } from 'vitest'
import type { ShellParser } from '../../shell/parse/index.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Limit, PathSpec, MountMode } from '../../types.ts'
import type { ChildProcess } from '../../process/child.ts'
import type { SpawnRequest } from '../../process/types.ts'
import type { SessionState } from '../session/session.ts'
import { Workspace } from './workspace.ts'

let parser: ShellParser
beforeAll(async () => {
  parser = await getTestParser()
})

it('preserves literal argv and uses the admission gate', async () => {
  const ws = new Workspace({}, { runtimes: [], shellParser: parser })
  try {
    const argv = ['printf', '%s|', 'a b', '$(echo bad)', '*', "a'b", '', '`']
    const child = ws.spawn({ argv })
    const result = await child.communicate()
    expect(
      result.exitCode,
      JSON.stringify(await child.wait()) + new TextDecoder().decode(result.stderr),
    ).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe("a b|$(echo bad)|*|a'b||`|")
    ws.createSession('limited', {
      profile: { commands: { deny: [{ commands: ['printf'], reason: 'no' }] } },
    })
    const denied = await ws.spawn({ argv }, 'limited').communicate()
    expect(denied.exitCode).not.toBe(0)
    expect(denied.stdout.byteLength).toBe(0)
  } finally {
    await ws.close()
  }
})

it('drains stdin and stdout concurrently and isolates cwd', async () => {
  const ws = new Workspace({}, { runtimes: [], shellParser: parser })
  try {
    const data = new TextEncoder().encode('x'.repeat(300000))
    expect((await ws.spawn({ argv: ['cat'] }).communicate(data)).stdout).toEqual(data)
    const result = await ws
      .spawn({ argv: ['pwd'], cwd: PathSpec.fromStrPath('/tmp') })
      .communicate()
    expect(new TextDecoder().decode(result.stdout)).toBe('/tmp\n')
    expect(new TextDecoder().decode((await ws.shell('pwd')).stdout)).toBe('/\n')
  } finally {
    await ws.close()
  }
})

it('revokes captured process doors on profile replacement', async () => {
  const ws = new Workspace({}, { runtimes: [], shellParser: parser })
  try {
    ws.createSession('a')
    ws.createSession('b')
    const child = ws.spawn({ argv: ['sleep', '30'] }, 'a')
    child.stdin.close()
    const view = ws.processes.view('a')
    expect(view.get(child.pid)).not.toBeNull()
    expect(ws.processes.view('b').get(child.pid)).toBeNull()
    await ws.setSessionProfile('a', {
      processes: { metadata: 'none', details: 'none', control: 'none', spawn: false },
    })
    expect(view.list()).toEqual([])
    expect(() => ws.spawn({ argv: ['true'] }, 'a')).toThrow('not permitted')
    await child.wait()
  } finally {
    await ws.close()
  }
})

it('Monty keeps its unsupported subprocess import', async () => {
  const ws = new Workspace(
    {},
    { mode: MountMode.EXEC, runtimes: [new MontyRuntime()], shellParser: parser },
  )
  try {
    const result = await ws.spawn({ argv: ['python', '-c', 'import subprocess'] }).communicate()
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain('ModuleNotFoundError')
    const helper = await ws.spawn({ argv: ['python', '-c', 'mirage_run([])'] }).communicate()
    expect(helper.exitCode).toBe(1)
    expect(new TextDecoder().decode(helper.stderr)).toContain('NameError')
  } finally {
    await ws.close()
  }
}, 30000)

it('Pyodide subprocess flushes writes and invalidates reads without blocking the host', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.EXEC, runtimes: [new PyodideRuntime()], shellParser: parser },
  )
  try {
    const code = `import subprocess
from pathlib import Path
p = Path('/data/file')
p.write_text('before')
assert p.read_text() == 'before'
r = subprocess.run(['cat', '/data/file'], capture_output=True, text=True, check=True)
assert r.stdout == 'before'
subprocess.run(['sh', '-c', 'echo after > /data/file'], check=True)
assert p.read_text() == 'after\\n'
print(subprocess.run(['printf', '%s', '$(literal)'], capture_output=True, text=True).stdout)`
    const result = await ws.spawn({ argv: ['python', '-c', code] }).communicate()
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('$(literal)\n')
  } finally {
    await ws.close()
  }
}, 60000)

it('Pyodide keeps standard subprocess helpers, pipes, environments and timeouts', async () => {
  const ws = new Workspace(
    {},
    { mode: MountMode.EXEC, runtimes: [new PyodideRuntime()], shellParser: parser },
  )
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
  }, 5)
  try {
    await ws.shell(
      'export PARENT=workspace; only_function() { echo wrong; }; printf() { echo wrong; }',
    )
    const code = `import os, subprocess, sys, shutil
assert shutil.which("python3") == "/usr/bin/python3"
assert shutil.which("cd") is None
os.environ['PARENT'] = 'guest'
assert subprocess.check_output(['printenv', 'PARENT'], text=True) == 'guest\\n'
assert subprocess.run(['printenv', 'PARENT'], env={}, capture_output=True).returncode == 1
assert subprocess.check_output(['printenv'], env={}).strip() == b''
assert subprocess.check_output(['printf', '%s', 'a b;$HOME']) == b'a b;$HOME'
assert subprocess.check_output('printf ok', shell=True) == b'ok'
assert subprocess.check_output([sys.executable, '-c', 'print(42)']) == b'42\\n'
for name in ['missing-executable', 'only_function', 'cd']:
    try:
        subprocess.Popen([name])
    except FileNotFoundError:
        pass
    else:
        raise AssertionError(name)
assert subprocess.call(['false']) == 1
try:
    subprocess.check_call(['false'])
except subprocess.CalledProcessError as e:
    assert e.returncode == 1
else:
    raise AssertionError('check_call')
with subprocess.Popen(['cat'], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as p:
    assert p.poll() is None
    out, err = p.communicate(b'x' * 300000)
    assert out == b'x' * 300000 and err is None
    assert p.returncode == 0
with subprocess.Popen(['printf', 'hello\\n'], stdout=subprocess.PIPE, text=True) as p:
    assert p.stdout.readline() == 'hello\\n'
    assert p.wait() == 0
with subprocess.Popen(['printf', 'αβγ'], stdout=subprocess.PIPE, text=True) as p:
    assert p.stdout.read(1) == 'α'
    assert p.communicate()[0] == 'βγ'
r = subprocess.run(['sh', '-c', 'printf out; printf err >&2'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
assert r.stdout == b'outerr' and r.stderr is None
p = subprocess.Popen(['sh', '-c', 'printf before; sleep 0.2; printf after'], stdout=subprocess.PIPE)
try:
    p.communicate(timeout=0.03)
except subprocess.TimeoutExpired as e:
    assert e.output in (b'', b'before')
else:
    raise AssertionError('timeout')
assert p.communicate()[0] == b'beforeafter'
p = subprocess.Popen(['sleep', '30'])
try:
    p.wait(timeout=0.01)
except subprocess.TimeoutExpired:
    assert p.poll() is None
p.terminate()
assert p.wait() == -15
try:
    subprocess.run(['sleep', '30'], timeout=0.01)
except subprocess.TimeoutExpired:
    pass
else:
    raise AssertionError('run timeout')
print('ok')`
    const result = await ws.spawn({ argv: ['python', '-c', code] }).communicate()
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('ok\n')
    expect(ticks).toBeGreaterThan(10)
    expect(ws.processes.live()).toHaveLength(0)
  } finally {
    clearInterval(timer)
    await ws.close()
  }
}, 60000)

it('spawn uses programs and exported environment', async () => {
  const ws = new Workspace({}, { runtimes: [], shellParser: parser })
  try {
    await ws.shell(
      'LOCAL=private; export PARENT=outer; f() { echo wrong; }; printf() { echo wrong; }',
    )
    for (const name of ['f', 'cd', 'missing']) expect(() => ws.spawn({ argv: [name] })).toThrow()
    const result = await ws.spawn({ argv: ['printf', '-v', 'name', 'value'] }).communicate()
    expect(new TextDecoder().decode(result.stdout)).toBe('-v')
    expect((await ws.spawn({ argv: ['printenv', 'LOCAL'] }).communicate()).exitCode).toBe(1)
    expect(
      (await ws.spawn({ argv: ['printenv', 'PARENT'], env: {}, replaceEnv: true }).communicate())
        .exitCode,
    ).toBe(1)
    const childEnv = await ws
      .spawn({ argv: ['printenv', 'PARENT'], env: { PARENT: 'child' } })
      .communicate()
    expect(new TextDecoder().decode(childEnv.stdout)).toBe('child\n')
    expect(new TextDecoder().decode((await ws.shell('printf %s "$PARENT"')).stdout)).toBe('outer')
    const merged = await ws
      .spawn({ argv: ['sh', '-c', 'printf out; printf err >&2'], mergeStderr: true })
      .communicate()
    expect(new TextDecoder().decode(merged.stdout)).toBe('outerr')
    expect(merged.stderr).toHaveLength(0)
  } finally {
    await ws.close()
  }
})

it('spawn output obeys the command limit wherever the parent writes', async () => {
  const ws = new Workspace({}, { runtimes: [], shellParser: parser })
  try {
    const session = ws.createSession('capped', {
      profile: { commandLimits: { cat: new Limit({ maxBytes: 4 }) } },
    })
    const piped = session.fork()
    piped.terminalOutput = false
    const spawn = (
      ws as unknown as {
        spawnForSession(request: SpawnRequest, session: SessionState): ChildProcess
      }
    ).spawnForSession.bind(ws)
    const result = await spawn({ argv: ['cat'] }, piped).communicate(
      new TextEncoder().encode('0123456789'),
    )
    expect(new TextDecoder().decode(result.stdout)).toBe('0123')
  } finally {
    await ws.close()
  }
})

it('Pyodide inherits unread stdin and reaps unfinished children at guest exit', async () => {
  const ws = new Workspace(
    {},
    { mode: MountMode.EXEC, runtimes: [new PyodideRuntime()], shellParser: parser },
  )
  try {
    const code = `import subprocess, sys
assert sys.stdin.buffer.read(2) == b'ab'
subprocess.run(['true'], check=True)
assert subprocess.check_output(['cat']) == b'cdef'
assert sys.stdin.buffer.read() == b''
subprocess.run(['sh', '-c', 'sleep 30 &'], check=True)
subprocess.Popen(['sleep', '30'])
print('done')`
    const result = await ws
      .spawn({ argv: ['python', '-c', code] })
      .communicate(new TextEncoder().encode('abcdef'))
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('done\n')
    expect(ws.processes.live()).toHaveLength(0)
  } finally {
    await ws.close()
  }
}, 60000)

it('Pyodide subprocess retains the profile spawn restriction', async () => {
  const ws = new Workspace(
    {},
    { mode: MountMode.EXEC, runtimes: [new PyodideRuntime()], shellParser: parser },
  )
  try {
    ws.createSession('restricted', {
      profile: {
        processes: { spawn: false, metadata: 'session', details: 'session', control: 'session' },
      },
    })
    const code = `import subprocess
try:
    subprocess.Popen(['true'])
except PermissionError:
    print('denied')
else:
    raise AssertionError('spawn bypassed profile')`
    const result = await ws.shell(`python -c ${shellQuote(code)}`, { sessionId: 'restricted' })
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('denied\n')
  } finally {
    await ws.close()
  }
}, 30000)
