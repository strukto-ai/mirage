import { MontyRuntime } from '../../runtime/python/monty/runtime.ts'
import { PyodideRuntime } from '../../runtime/python/pyodide/runtime.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { beforeAll, expect, it } from 'vitest'
import type { ShellParser } from '../../shell/parse/index.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { PathSpec, MountMode } from '../../types.ts'
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

it('Monty guest calls use the admitted argv door, including nested Python', async () => {
  const ws = new Workspace(
    {},
    { mode: MountMode.EXEC, runtimes: [new MontyRuntime()], shellParser: parser },
  )
  try {
    const code = 'print((await mirage_run(["python", "-c", "print(42)"]))["stdout"])'
    const result = await ws.spawn({ argv: ['python', '-c', code] }).communicate()
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('42\n\n')
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
