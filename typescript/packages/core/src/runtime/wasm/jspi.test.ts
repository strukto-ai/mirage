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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { provideQuickJsModule } from '../js/quickjs/loader.ts'
import { QUICKJS_HOME_ENV } from '../js/quickjs/runtime.ts'
import { jspiAvailable } from './jspi.ts'

const home = process.env[QUICKJS_HOME_ENV]
const DEC = new TextDecoder()

// The module as an edge isolate hands it in, compiled ahead of the run.
// With no home left to load one from, a worker could not start, so every
// run here is the isolate's own under JSPI.
describe.skipIf(home === undefined || !jspiAvailable())('qjs in the host isolate', () => {
  let ws: Workspace

  beforeAll(() => {
    const bytes = readFileSync(join(home ?? '', 'qjs-wasi.wasm'))
    provideQuickJsModule(() => WebAssembly.compile(bytes))
    Reflect.deleteProperty(process.env, QUICKJS_HOME_ENV)
    ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: ['quickjs', 'workspace'] },
    )
  })

  afterAll(async () => {
    await ws.close()
    if (home !== undefined) process.env[QUICKJS_HOME_ENV] = home
  })

  async function run(line: string): Promise<[string, string, number]> {
    const io = await ws.shell(line)
    return [DEC.decode(io.stdout), DEC.decode(io.stderr), io.exitCode]
  }

  it('runs a program and exits as it says', async () => {
    expect(await run('node -e "console.log(1 + 1)"')).toEqual(['2\n', '', 0])
    expect((await run('node -e "process.exit(3)"'))[2]).toBe(3)
  })

  it("reads and writes the workspace's files", async () => {
    const [out] = await run(
      `node -e "require('fs').writeFileSync('/data/a.txt', 'hi'); console.log(require('fs').readdirSync('/data'))"`,
    )
    expect(out).toBe("[ 'a.txt' ]\n")
    expect(await run('cat /data/a.txt')).toEqual(['hi', '', 0])
  })

  it('takes input as it comes and writes into a pipe', async () => {
    const [out] = await run(
      `printf 'a\\nb\\n' | node -e "(async () => { for await (const c of process.stdin) process.stdout.write(String(c).toUpperCase()) })()" | wc -l`,
    )
    expect(out.trim()).toBe('2')
  })

  it("waits out a timer on the host's own clock", async () => {
    expect(
      await run(`node -e "setTimeout(() => console.log('late'), 20); console.log('first')"`),
    ).toEqual(['first\nlate\n', '', 0])
  })

  it('ends a guest at its next call once its deadline passes', async () => {
    const [, , code] = await run('timeout 1 node -e "setInterval(() => {}, 10)"')
    expect(code).toBe(124)
  })
})
