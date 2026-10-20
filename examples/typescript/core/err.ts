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

import { MountMode, RAMVFS, Workspace, type ExecuteResult } from '@struktoai/mirage-node'

const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })

const APP_LOG = 'INFO  server started\nERROR disk full\nINFO  request ok\nERROR timeout\n'

async function seed(): Promise<void> {
  await ws.vfs.mkdir('/data/logs')
  await ws.vfs.mkdir('/data/src')
  await ws.vfs.write('/data/logs/app.log', APP_LOG)
  await ws.vfs.write('/data/src/main.py', 'def main():\n    print("hello")\n')
  await ws.vfs.write('/data/src/utils.py', 'def add(a, b):\n    return a + b\n')
  await ws.vfs.write('/data/notes.txt', 'line one\nline two\nline three\n')
}

function logResult(label: string, io: ExecuteResult): void {
  const stdout = io.stdoutText.replace(/\n+$/, '')
  const stderr = io.stderrText.replace(/\n+$/, '')
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  $ ${label}`)
  console.log(`  exit_code=${String(io.exitCode)}`)
  if (stdout !== '') for (const line of stdout.split('\n')) console.log(`  stdout │ ${line}`)
  if (stderr !== '') for (const line of stderr.split('\n')) console.log(`  stderr │ ${line}`)
  if (stdout === '' && stderr === '') console.log('  (no output)')
}

async function main(): Promise<void> {
  await seed()

  console.log('='.repeat(60))
  console.log(' Stderr Warnings & Error Handling Demo')
  console.log('='.repeat(60))

  // ── file not found ───────────────────────────────────────────────────
  logResult('cat /data/nonexistent.txt', await ws.shell('cat /data/nonexistent.txt'))

  // ── ls on missing directory ──────────────────────────────────────────
  logResult('ls /data/missing/', await ws.shell('ls /data/missing/'))

  // ── grep on missing file ─────────────────────────────────────────────
  logResult('grep hello /data/ghost.txt', await ws.shell('grep hello /data/ghost.txt'))

  // ── find on missing path ─────────────────────────────────────────────
  logResult('find /data/nowhere', await ws.shell('find /data/nowhere'))

  // ── recursive grep with -l (files only) on valid dir ─────────────────
  logResult('grep -rl def /data/src', await ws.shell('grep -rl def /data/src'))

  // ── pipe: error in first stage ───────────────────────────────────────
  logResult(
    'cat /data/nonexistent.txt | head -n 1',
    await ws.shell('cat /data/nonexistent.txt | head -n 1'),
  )

  // ── pipe: valid read, grep finds nothing ─────────────────────────────
  logResult(
    'cat /data/notes.txt | grep ZZZZZ',
    await ws.shell('cat /data/notes.txt | grep ZZZZZ'),
  )

  // ── && chain: first fails → second skipped ──────────────────────────
  logResult(
    "cat /data/nonexistent.txt && echo 'should not print'",
    await ws.shell("cat /data/nonexistent.txt && echo 'this should not print'"),
  )

  // ── || chain: first fails → fallback runs ────────────────────────────
  logResult(
    "cat /data/nonexistent.txt || echo 'fallback executed'",
    await ws.shell("cat /data/nonexistent.txt || echo 'fallback executed'"),
  )

  // ── complex: (grep | sort) && echo ok || echo fail ───────────────────
  logResult(
    '(grep ERROR /data/logs/app.log | sort) && echo ok || echo fail',
    await ws.shell('(grep ERROR /data/logs/app.log | sort) && echo ok || echo fail'),
  )

  // ── complex: same but grep finds nothing → fail path ─────────────────
  logResult(
    '(grep ZZZZZ /data/logs/app.log | sort) && echo ok || echo fail',
    await ws.shell('(grep ZZZZZ /data/logs/app.log | sort) && echo ok || echo fail'),
  )

  // ── semicolon: independent commands, first fails ─────────────────────
  logResult(
    'cat /data/nonexistent.txt ; cat /data/notes.txt | head -n 1',
    await ws.shell('cat /data/nonexistent.txt ; cat /data/notes.txt | head -n 1'),
  )

  // ── rm missing file (no -f) vs rm -f ────────────────────────────────
  logResult('rm /data/nonexistent.txt', await ws.shell('rm /data/nonexistent.txt'))
  logResult('rm -f /data/nonexistent.txt', await ws.shell('rm -f /data/nonexistent.txt'))

  // ── diff with missing file ───────────────────────────────────────────
  logResult(
    'diff /data/notes.txt /data/nonexistent.txt',
    await ws.shell('diff /data/notes.txt /data/nonexistent.txt'),
  )

  // ── stat on missing file ─────────────────────────────────────────────
  logResult('stat /data/nonexistent.txt', await ws.shell('stat /data/nonexistent.txt'))

  // ── tree on missing dir ──────────────────────────────────────────────
  logResult('tree /data/nowhere', await ws.shell('tree /data/nowhere'))

  // ── multi-pipe success: grep | sort | head ───────────────────────────
  logResult(
    'grep ERROR /data/logs/app.log | sort | head -n 1',
    await ws.shell('grep ERROR /data/logs/app.log | sort | head -n 1'),
  )

  // ── execution history: exit codes per command ─────────────────────
  console.log(`\n${'═'.repeat(60)}`)
  console.log(' Execution History')
  console.log('═'.repeat(60))

  for (const entry of (await ws.history()).slice(-6)) {
    console.log(`\n  $ ${String(entry.command)}`)
    console.log(`    exit=${String(entry.exit_code)}`)
  }

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
