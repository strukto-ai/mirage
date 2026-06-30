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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

// Direct port of tests/workspace/test_cwd_integration.py.
// Exercises cwd tracking + `cd`/`pwd`/`ls` across quoting/escaping of
// paths that contain spaces and apostrophes.

const ENC = new TextEncoder()

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  r.store.dirs.add('/')
  r.store.dirs.add('/subdir')
  r.store.dirs.add('/subdir/nested')
  r.store.files.set('/subdir/file.txt', ENC.encode('hello'))
  r.store.files.set('/subdir/nested/deep.txt', ENC.encode('deep'))

  const registry = new OpsRegistry()
  registry.registerResource(r)
  return new Workspace(
    { '/ram/': r },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

async function makeWsSpecial(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  r.store.dirs.add('/')
  r.store.dirs.add("/Zecheng's Server")
  r.store.files.set("/Zecheng's Server/image.png", ENC.encode('PNG'))

  const registry = new OpsRegistry()
  registry.registerResource(r)
  return new Workspace(
    { '/ram/': r },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

async function runOut(ws: Workspace, cmd: string): Promise<string> {
  const io = await ws.execute(cmd)
  return stdoutStr(io)
}

describe('cwd integration (port of tests/workspace/test_cwd_integration.py)', () => {
  it('pwd default → non-empty stdout', async () => {
    const ws = await makeWs()
    const out = await runOut(ws, 'pwd')
    expect(out.trim()).not.toBe('')
    await ws.close()
  })

  it('cd /ram && pwd → /ram', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram && pwd')).trim()).toBe('/ram')
    await ws.close()
  })

  it('cd /ram/subdir && pwd → /ram/subdir', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram/subdir && pwd')).trim()).toBe('/ram/subdir')
    await ws.close()
  })

  it('cd /ram/subdir && cd .. && pwd → /ram', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram/subdir && cd .. && pwd')).trim()).toBe('/ram')
    await ws.close()
  })

  it('cd /ram/subdir && cd / && pwd → /', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram/subdir && cd / && pwd')).trim()).toBe('/')
    await ws.close()
  })

  it('cd ~ with $HOME unset → error', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cd /ram/subdir && cd ~')
    expect(io.exitCode).not.toBe(0)
    await ws.close()
  })

  it('bare cd with $HOME unset → error (HOME not set)', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cd /ram/subdir && cd')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('HOME not set')
    await ws.close()
  })

  it('bare cd with $HOME set → goes home', async () => {
    const ws = await makeWs()
    const out = await runOut(ws, 'export HOME=/ram/subdir && cd /ram && cd && pwd')
    expect(out.trim()).toBe('/ram/subdir')
    await ws.close()
  })

  it('cd /ram && cd subdir && pwd → /ram/subdir (relative)', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram && cd subdir && pwd')).trim()).toBe('/ram/subdir')
    await ws.close()
  })

  it('cd /ram/subdir && ls → includes file.txt', async () => {
    const ws = await makeWs()
    expect(await runOut(ws, 'cd /ram/subdir && ls')).toContain('file.txt')
    await ws.close()
  })

  it('cd /ram && ls → includes subdir', async () => {
    const ws = await makeWs()
    expect(await runOut(ws, 'cd /ram && ls')).toContain('subdir')
    await ws.close()
  })

  it('cd /ram/subdir && cd nested && pwd → /ram/subdir/nested', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram/subdir && cd nested && pwd')).trim()).toBe(
      '/ram/subdir/nested',
    )
    await ws.close()
  })

  it('cd /ram/subdir/nested && cd ../.. && pwd → /ram', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram/subdir/nested && cd ../.. && pwd')).trim()).toBe('/ram')
    await ws.close()
  })

  it("ls with backslash-escaped path: ls /ram/Zecheng\\'s\\ Server/", async () => {
    const ws = await makeWsSpecial()
    expect(await runOut(ws, "ls /ram/Zecheng\\'s\\ Server/")).toContain('image.png')
    await ws.close()
  })

  it('ls with double-quoted path containing apostrophe + space', async () => {
    const ws = await makeWsSpecial()
    expect(await runOut(ws, 'ls "/ram/Zecheng\'s Server/"')).toContain('image.png')
    await ws.close()
  })

  it('cd backslash-escaped && ls → includes image.png', async () => {
    const ws = await makeWsSpecial()
    expect(await runOut(ws, "cd /ram/Zecheng\\'s\\ Server && ls")).toContain('image.png')
    await ws.close()
  })

  it('cd double-quoted && ls → includes image.png', async () => {
    const ws = await makeWsSpecial()
    expect(await runOut(ws, 'cd "/ram/Zecheng\'s Server" && ls')).toContain('image.png')
    await ws.close()
  })

  it("cd backslash-escaped && pwd → /ram/Zecheng's Server", async () => {
    const ws = await makeWsSpecial()
    expect((await runOut(ws, "cd /ram/Zecheng\\'s\\ Server && pwd")).trim()).toBe(
      "/ram/Zecheng's Server",
    )
    await ws.close()
  })

  it('pwd default → /', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'pwd')).trim()).toBe('/')
    await ws.close()
  })

  it('cd /ram/subdir && echo $PWD → /ram/subdir', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram/subdir && echo $PWD')).trim()).toBe('/ram/subdir')
    await ws.close()
  })

  it('echo $HOME with $HOME unset → empty', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'echo "[$HOME]"')).trim()).toBe('[]')
    await ws.close()
  })

  it('cd updates $OLDPWD', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram && cd /ram/subdir && echo $OLDPWD')).trim()).toBe('/ram')
    await ws.close()
  })

  it('cd - returns to and prints previous dir', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram && cd /ram/subdir && cd -')).trim()).toBe('/ram')
    await ws.close()
  })

  it('cd - swaps cwd', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram && cd /ram/subdir && cd - > /dev/null && pwd')).trim()).toBe(
      '/ram',
    )
    await ws.close()
  })

  it('cd - without OLDPWD errors', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cd -')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('OLDPWD not set')
    await ws.close()
  })

  it('custom HOME: cd ~ uses $HOME', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'export HOME=/ram/subdir && cd ~ && pwd')).trim()).toBe('/ram/subdir')
    await ws.close()
  })

  it('custom HOME: echo $HOME', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'export HOME=/ram/subdir && echo $HOME')).trim()).toBe('/ram/subdir')
    await ws.close()
  })

  it('tilde expands for commands', async () => {
    const ws = await makeWs()
    expect(await runOut(ws, 'export HOME=/ram/subdir && cat ~/file.txt')).toBe('hello')
    await ws.close()
  })

  it('quoted tilde is not expanded', async () => {
    const ws = await makeWs()
    const io = await ws.execute('export HOME=/ram/subdir && cat "~/file.txt"')
    expect(io.exitCode).not.toBe(0)
    await ws.close()
  })

  it('subshell does not leak $OLDPWD', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram && (cd /ram/subdir) && echo $OLDPWD')).trim()).toBe('/')
    await ws.close()
  })

  it('subshell does not leak cwd', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd /ram && (cd /ram/subdir) && pwd')).trim()).toBe('/ram')
    await ws.close()
  })

  it('cd //ram collapses double slash → /ram', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd //ram && pwd')).trim()).toBe('/ram')
    await ws.close()
  })

  it('cd ///ram/subdir collapses triple slash', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd ///ram/subdir && pwd')).trim()).toBe('/ram/subdir')
    await ws.close()
  })

  it('cd -P dir → physical flag accepted', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd -P /ram/subdir && pwd')).trim()).toBe('/ram/subdir')
    await ws.close()
  })

  it('cd -L dir → logical flag accepted', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd -L /ram && pwd')).trim()).toBe('/ram')
    await ws.close()
  })

  it('cd -LP dir → clustered flags accepted', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd -LP /ram && pwd')).trim()).toBe('/ram')
    await ws.close()
  })

  it('cd -- dir → terminates options', async () => {
    const ws = await makeWs()
    expect((await runOut(ws, 'cd -- /ram && pwd')).trim()).toBe('/ram')
    await ws.close()
  })

  it('cd -x → invalid option, exit 2', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cd -x /ram')
    expect(io.exitCode).toBe(2)
    expect(stderrStr(io)).toContain('invalid option')
    await ws.close()
  })

  it('cd a b → too many arguments, exit 1', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cd /ram /ram/subdir')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('too many arguments')
    await ws.close()
  })

  it("cd '~' (quoted) is literal, not $HOME", async () => {
    const ws = await makeWs()
    const io = await ws.execute("cd /ram && cd '~'")
    expect(io.exitCode).not.toBe(0)
    await ws.close()
  })

  it('cd searches $CDPATH and prints the resolved dir', async () => {
    const ws = await makeWs()
    const out = await runOut(ws, 'export CDPATH=/ram && cd subdir && pwd')
    const lines = out.split('\n').filter((l) => l !== '')
    expect(lines[lines.length - 1]).toBe('/ram/subdir')
    expect(lines.slice(0, -1)).toContain('/ram/subdir')
    await ws.close()
  })
})
