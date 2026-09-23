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
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

describe('Workspace + Python mount', () => {
  it('Workspace.addMount makes paths visible inside Python after it loads', async () => {
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const ws = new Workspace({}, { mode: MountMode.EXEC, ops, shellParser: parser })
    ws.addMount('/ram', ram, MountMode.EXEC)
    await ws.vfs.writeFile('/ram/hello.txt', 'world')
    const io = await ws.shell(`python3 -c "with open('/ram/hello.txt') as f: print(f.read())"`)
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('world')
    await ws.close()
  }, 90_000)

  it('Python writes flush back through the bridge', async () => {
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const ws = new Workspace({}, { mode: MountMode.EXEC, ops, shellParser: parser })
    ws.addMount('/ram', ram, MountMode.EXEC)
    const io = await ws.shell(`python3 -c "with open('/ram/out.txt', 'wb') as f: f.write(b'data')"`)
    expect(io.exitCode).toBe(0)
    const back = await ws.vfs.readFile('/ram/out.txt')
    expect(new TextDecoder().decode(back)).toBe('data')
    await ws.close()
  }, 90_000)

  it('Workspace.addMount does not load Pyodide when no Python ever runs', async () => {
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const ws = new Workspace({}, { mode: MountMode.EXEC, ops, shellParser: parser })
    ws.addMount('/ram', ram, MountMode.EXEC)
    await ws.vfs.writeFile('/ram/never.txt', 'unused')
    const io = await ws.shell('echo hello')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('hello\n')
    await ws.close()
  }, 30_000)

  it('unmount drains in-flight Python addMount before closing the VFS', async () => {
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const ws = new Workspace({}, { mode: MountMode.EXEC, ops, shellParser: parser })
    ws.addMount('/ram', ram, MountMode.EXEC)
    await ws.vfs.writeFile('/ram/seed.txt', 'seed')
    const io = await ws.shell(`python3 -c "pass"`)
    expect(io.exitCode).toBe(0)
    await ws.unmount('/ram/')
    const ram2 = new RAMVFS()
    ops.registerVfs(ram2)
    ws.addMount('/ram', ram2, MountMode.WRITE)
    await ws.vfs.writeFile('/ram/post.txt', 'post')
    expect(new TextDecoder().decode(await ws.vfs.readFile('/ram/post.txt'))).toBe('post')
    await ws.close()
  }, 90_000)

  it('Python writes a 50KB chunked file end-to-end', async () => {
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const ws = new Workspace({}, { mode: MountMode.EXEC, ops, shellParser: parser })
    ws.addMount('/ram', ram, MountMode.EXEC)
    const code =
      "data = b'X' * 1024\n" +
      "with open('/ram/big.bin', 'wb') as f:\n" +
      '    for _ in range(50):\n' +
      '        f.write(data)\n'
    await ws.vfs.writeFile('/ram/chunked.py', code)
    const io = await ws.shell('python3 /ram/chunked.py')
    expect(io.exitCode).toBe(0)
    const back = await ws.vfs.readFile('/ram/big.bin')
    expect(back.length).toBe(50 * 1024)
    expect(back[0]).toBe(0x58)
    expect(back[back.length - 1]).toBe(0x58)
    await ws.close()
  }, 90_000)

  it('PIL saves an image to a mounted prefix and loads it back', async () => {
    const parser = await getTestParser()
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const ws = new Workspace(
      {},
      {
        mode: MountMode.EXEC,
        ops,
        shellParser: parser,
        python: { autoLoadFromImports: true },
      },
    )
    ws.addMount('/ram', ram, MountMode.EXEC)
    const code =
      'from PIL import Image\n' +
      "img = Image.new('RGB', (4, 4), color='red')\n" +
      "img.save('/ram/icon.png')\n" +
      "loaded = Image.open('/ram/icon.png')\n" +
      'loaded.load()\n' +
      'print(loaded.size)\n'
    await ws.vfs.writeFile('/ram/pil_demo.py', code)
    const io = await ws.shell('python3 /ram/pil_demo.py')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('(4, 4)')
    const bytes = await ws.vfs.readFile('/ram/icon.png')
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes[0]).toBe(0x89)
    expect(bytes[1]).toBe(0x50)
    expect(bytes[2]).toBe(0x4e)
    expect(bytes[3]).toBe(0x47)
    await ws.close()
  }, 120_000)
})
