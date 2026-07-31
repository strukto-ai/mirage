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

import { MountMode, RAMResource, ScriptSource, Workspace } from '@struktoai/mirage-node'

// A JS-only world with a JS policy. The quickjs runtime carries the
// evaluator capability, so it doubles as the policy engine: the policy
// script below is JAVASCRIPT, evaluated per line with `ctx` bound as a
// global, and its completion value (the last expression) is the
// verdict. Same contract as python policy scripts on monty/pyodide:
// a runtime name places the line, null passes, {deny: reason} refuses
// it before anything runs (exit 126).

const JS_POLICY = new ScriptSource(
  "ctx.commands.some((c) => c.paths.some((p) => p.startsWith('/prod/')))" +
    " ? {deny: 'writes under /prod are blocked'}" +
    ' : null',
)

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/data': new RAMResource(), '/prod': new RAMResource() },
    { mode: MountMode.EXEC, runtimes: ['quickjs', 'vfs'], policy: JS_POLICY },
  )
  try {
    const ok = await ws.execute('echo hello > /data/notes.txt')
    console.log('write /data ->', ok.exitCode)
    const served = await ws.execute('node -e "console.log(6 * 7)"')
    console.log('node -e ->', served.stdoutText.trim())
    const denied = await ws.execute('cat /prod/secret.txt')
    console.log('touch /prod ->', denied.exitCode, denied.stderrText.trim())
  } finally {
    await ws.close()
  }
}

await main()
