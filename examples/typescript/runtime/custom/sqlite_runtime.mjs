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

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'

import { PROCESS_EXECUTOR, Runtime } from '@struktoai/mirage-node'

// The TypeScript twin of sqlite_runtime.py: a runtime Mirage does not ship,
// named from yaml as `./sqlite_runtime.mjs:SqliteRuntime`. It runs the
// host's sqlite3 on a database that lives in the workspace.
//
// The host program cannot see a mount, so the runtime copies the database
// out through ctx.vfs, runs sqlite3 on the copy and writes it back through
// ctx.vfs. Both calls go through the workspace dispatcher, so mount modes,
// policy and the cache apply to them exactly as they apply to cat or cp.

const CONFIG_KEYS = ['binary', 'readonly']

export class SqliteRuntime extends Runtime {
  [PROCESS_EXECUTOR] = true
  name = 'sqlite'

  constructor(options = {}) {
    super(options, ['sqlite3'], CONFIG_KEYS)
  }

  /**
   * Run `sqlite3 [OPTIONS] DATABASE [SQL]` on a workspace file.
   *
   * @param {unknown} _engine this runtime opens no engine.
   * @param {unknown[]} _paths unused; a process gets its argv as words.
   * @param {string[]} texts the argv, `sqlite3` first.
   * @param {object} ctx the session's cwd, stdin and files.
   */
  async runProcess(_engine, _paths, texts, ctx) {
    const binary = this.config.binary ?? 'sqlite3'
    const readonly = this.config.readonly === true
    const args = texts.slice(1)
    const options = readonly ? ['-readonly'] : []
    const at = args.findIndex((a) => !a.startsWith('-'))
    const stdin = await collect(ctx.stdin)
    if (at === -1) return sqlite(binary, [...options, ...args], stdin)
    const database = posix.resolve(ctx.cwd.virtual, args[at])
    let before = new Uint8Array()
    try {
      before = await ctx.vfs.read(database, { raw: true })
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    const tmp = await mkdtemp(join(tmpdir(), 'sqlite-runtime-'))
    try {
      const local = join(tmp, 'db.sqlite')
      await writeFile(local, before)
      const argv = [...options, ...args.slice(0, at), local, ...args.slice(at + 1)]
      const result = await sqlite(binary, argv, stdin)
      const after = new Uint8Array(await readFile(local))
      if (!readonly && !Buffer.from(after).equals(Buffer.from(before))) {
        await ctx.vfs.write(database, after)
      }
      return result
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }
}

async function collect(source) {
  if (source === null || source === undefined) return new Uint8Array()
  if (source instanceof Uint8Array) return source
  const chunks = []
  for await (const chunk of source) chunks.push(chunk)
  return new Uint8Array(Buffer.concat(chunks))
}

function sqlite(binary, argv, stdin) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, argv)
    const out = []
    const err = []
    proc.stdout.on('data', (c) => out.push(c))
    proc.stderr.on('data', (c) => err.push(c))
    proc.on('error', reject)
    proc.on('close', (code) => {
      const stderr = Buffer.concat(err)
      resolve({
        stdout: new Uint8Array(Buffer.concat(out)),
        stderr: stderr.length > 0 ? new Uint8Array(stderr) : null,
        exitCode: code ?? 1,
      })
    })
    proc.stdin.end(stdin)
  })
}
