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

import { MountMode, PostgresVFS, Workspace } from '@struktoai/mirage-browser'

const logEl = document.getElementById('log')!

function line(text: string, cls?: string): void {
  const div = document.createElement('div')
  if (cls !== undefined) div.className = cls
  div.textContent = text
  logEl.appendChild(div)
}

// Python's shlex.quote, so the printed commands match the Python example.
function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

// Shows the result and records it on #log as data-status, which is what
// the smoke test reads: the log text carries backend data and can say
// anything, done. and failed. included.
function finish(ok: boolean): void {
  line(ok ? 'done.' : 'failed.', ok ? 'ok' : 'err')
  logEl.dataset.status = ok ? 'done' : 'failed'
}

// Set by any command that exits non-zero, so the page finishes failed.
let failed = false

async function run(ws: Workspace, cmd: string): Promise<void> {
  line(`$ ${cmd}`, 'prompt')
  const r = await ws.shell(cmd)
  const out = r.stdoutText.replace(/\s+$/, '')
  if (out !== '') line(out)
  const err = r.stderrText.replace(/\s+$/, '')
  if (err !== '') line(err, 'err')
  if (r.exitCode !== 0) {
    line(`exit=${String(r.exitCode)}`, 'err')
    failed = true
  }
}

async function main(): Promise<void> {
  line('=== Postgres via Neon HTTP (browser driver) ===', 'ok')

  // The browser driver speaks Neon's HTTP transport, so this must be a Neon
  // DSN, ideally a read-only role: the page ships it to the browser.
  const dsn = __POSTGRES_DSN__
  if (dsn === '') {
    line('set POSTGRES_DSN (a Neon DSN) in .env.development', 'err')
    finish(false)
    return
  }
  const vfs = new PostgresVFS({ dsn, schemas: ['public'] })
  const ws = new Workspace({ '/pg/': vfs }, { mode: MountMode.READ })

  try {
    await run(ws, 'ls /pg')
    await run(ws, 'head -n 20 /pg/database.json')

    const tablesRes = await ws.shell('ls /pg/public/tables')
    const tables = tablesRes.stdoutText.split('\n').filter((s) => s.length > 0)
    if (tables.length === 0) {
      line('no tables in the public schema', 'err')
      finish(false)
      return
    }
    const dir = `/pg/public/tables/${tables[0]!}`

    await run(ws, `ls ${shellQuote(dir)}`)
    await run(ws, `cat ${shellQuote(`${dir}/schema.json`)}`)
    await run(ws, `head -n 3 ${shellQuote(`${dir}/rows.jsonl`)}`)
    await run(ws, `wc -l ${shellQuote(`${dir}/rows.jsonl`)}`)
    await run(ws, `jq ".name" ${shellQuote(`${dir}/schema.json`)}`)

    line('')
    finish(!failed)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  line(String(err instanceof Error ? (err.stack ?? err.message) : err), 'err')
  finish(false)
})
