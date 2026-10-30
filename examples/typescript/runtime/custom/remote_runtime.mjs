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

import { posix } from 'node:path'

import { EXTERNAL_COMMANDS, PROCESS_EXECUTOR, Runtime } from '@struktoai/mirage-node'

// The TypeScript twin of remote_runtime.py: a runtime for an execution
// service Mirage does not ship, named from yaml as
// `./remote_runtime.mjs:RemoteRuntime`. It captures python3, python, node
// and every program Mirage does not run itself.
//
// The service cannot see a mount, so the runtime sends it the session's
// working directory and writes back the files the program changed. Both go
// through ctx.vfs, so mount modes, policy and the cache apply to them.

const CONFIG_KEYS = ['url', 'maxBytes']
const MAX_BYTES = 16 * 1024 * 1024

export class RemoteRuntime extends Runtime {
  [PROCESS_EXECUTOR] = true
  name = 'remote'
  reach = 'remote'

  constructor(options = {}) {
    super(options, ['python3', 'python', 'node', EXTERNAL_COMMANDS], CONFIG_KEYS)
  }

  /**
   * Run one program on the service, in a copy of the working directory.
   * Aborting the run (`timeout`, a closed session) aborts the request, and
   * the service stops the program when the connection drops.
   *
   * @param {unknown} _engine this runtime opens no engine; fetch is global.
   * @param {unknown[]} _paths unused; a process gets its argv as words.
   * @param {string[]} texts the argv, program first.
   * @param {import('@struktoai/mirage-node').Context} ctx the session's cwd,
   *   stdin, files and abort signal.
   */
  async runProcess(_engine, _paths, texts, ctx) {
    const cwd = ctx.cwd.virtual
    const maxBytes = this.config.maxBytes ?? MAX_BYTES
    const files = await snapshot(ctx, cwd, maxBytes)
    const request = {
      argv: texts,
      stdin: b64(await collect(ctx.stdin, maxBytes)),
      files: Object.fromEntries(Object.entries(files).map(([rel, data]) => [rel, b64(data)])),
    }
    const resp = await fetch(this.config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: ctx.signal,
    })
    if (!resp.ok) throw new Error(`execution service answered ${resp.status}`)
    const answer = await resp.json()
    for (const [rel, data] of Object.entries(answer.files)) {
      let folder = cwd
      for (const part of rel.includes('/') ? posix.dirname(rel).split('/') : []) {
        folder = posix.join(folder, part)
        if (!(await ctx.vfs.exists(folder))) await ctx.vfs.mkdir(folder)
      }
      await ctx.vfs.write(posix.join(cwd, rel), unb64(data))
    }
    const stderr = unb64(answer.stderr)
    return {
      stdout: unb64(answer.stdout),
      stderr: stderr.length > 0 ? stderr : null,
      exitCode: answer.exit_code,
    }
  }
}

async function snapshot(ctx, cwd, maxBytes) {
  const files = {}
  let total = 0
  const mount = ctx.vfs.mountOf(cwd)
  const pending = [cwd]
  while (pending.length > 0) {
    const folder = pending.pop()
    for (const entry of await ctx.vfs.readdir(folder)) {
      // Copy the working directory's own mount only: another mount below
      // it (or /dev under the root) stays behind.
      if (ctx.vfs.mountOf(entry) !== mount) continue
      if (await ctx.vfs.isDir(entry)) {
        pending.push(entry)
        continue
      }
      const data = await ctx.vfs.read(entry, { raw: true })
      total += data.length
      if (total > maxBytes) throw new Error(`working directory is over ${maxBytes} bytes`)
      files[posix.relative(cwd, entry)] = data
    }
  }
  return files
}

// The service takes a run's input whole, so stop reading at the budget: an
// endless producer fails the run instead of hanging it.
async function collect(source, maxBytes) {
  if (source === null || source === undefined) return new Uint8Array()
  const chunks = []
  let total = 0
  for await (const chunk of source instanceof Uint8Array ? [source] : source) {
    chunks.push(chunk)
    total += chunk.length
    if (total > maxBytes) throw new Error(`stdin is over ${maxBytes} bytes`)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

function b64(data) {
  return Buffer.from(data).toString('base64')
}

function unb64(text) {
  return new Uint8Array(Buffer.from(text, 'base64'))
}
