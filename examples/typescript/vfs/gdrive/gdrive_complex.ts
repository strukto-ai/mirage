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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { GoogleDriveVFS, MountMode, Workspace, type GDriveConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function buildConfig(): GDriveConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required')
  }
  return { clientId, clientSecret, refreshToken }
}

const backend = new GoogleDriveVFS(buildConfig())
const ws = new Workspace({ '/gdrive/': backend }, { mode: MountMode.READ })

function opsSummary(): string {
  const records = ws.records
  const total = records.reduce((s, r) => s + (r.bytes ?? 0), 0)
  return `${String(records.length)} ops, ${String(total)} bytes transferred`
}

function lines(text: string): string[] {
  const trimmed = text.trim()
  return trimmed === '' ? [] : trimmed.split('\n')
}

// Python's shlex.quote, so the printed commands match the Python example.
function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function out(cmd: string): Promise<string> {
  return (await ws.shell(cmd)).stdoutText
}

async function main(): Promise<void> {
  // ── prime the cache: gdrive resolves paths via file IDs ──
  await ws.shell('ls /gdrive/')
  await ws.shell('ls /gdrive/mirage/')

  // ── caching: one full read warms the file cache ──
  console.log('--- caching: cat /gdrive/mirage/example.jsonl | wc -l ---')
  let r = await ws.shell('cat /gdrive/mirage/example.jsonl | wc -l')
  console.log(`  lines: ${r.stdoutText.trim()}`)
  console.log(`  Stats after caching: ${opsSummary()}`)

  console.log('\n=== EXECUTION ===\n')

  // ── simple grep ──
  console.log('--- grep mirage /gdrive/mirage/example.jsonl ---')
  let found = lines(await out('grep mirage /gdrive/mirage/example.jsonl'))
  console.log(`  Matches: ${String(found.length)}`)
  if (found.length > 0) console.log(`  First: ${found[0]!.slice(0, 80)}...`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── grep with limit ──
  console.log('\n--- grep -m 1 mirage /gdrive/mirage/example.jsonl ---')
  found = lines(await out('grep -m 1 mirage /gdrive/mirage/example.jsonl'))
  console.log(`  Matches: ${String(found.length)}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── pipe: grep | wc -l ──
  console.log('\n--- grep mirage /gdrive/mirage/example.jsonl | wc -l ---')
  r = await ws.shell('grep mirage /gdrive/mirage/example.jsonl | wc -l')
  console.log(`  Count: ${r.stdoutText.trim()}`)
  console.log(`  Exit code: ${String(r.exitCode)}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── pipe: grep | head ──
  console.log('\n--- grep mirage /gdrive/mirage/example.jsonl | head -n 3 ---')
  found = lines(await out('grep mirage /gdrive/mirage/example.jsonl | head -n 3'))
  console.log(`  Lines: ${String(found.length)}`)
  for (const ln of found) console.log(`    ${ln.slice(0, 80)}...`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── pipe: cat | grep | sort | uniq ──
  console.log('\n--- cat /gdrive/mirage/example.jsonl | grep queue-operation | sort | uniq ---')
  found = lines(await out('cat /gdrive/mirage/example.jsonl | grep queue-operation | sort | uniq'))
  console.log(`  Unique lines: ${String(found.length)}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── pipe: grep | cut (extract field) ──
  console.log(
    '\n--- rg queue-operation /gdrive/mirage/example.jsonl | head -n 5 | cut -d , -f 2 ---',
  )
  r = await ws.shell('rg queue-operation /gdrive/mirage/example.jsonl | head -n 5 | cut -d , -f 2')
  console.log(`  Fields:\n    ${r.stdoutText.trim()}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── && chain: grep && echo ──
  console.log("\n--- grep -m 1 mirage /gdrive/mirage/example.jsonl && echo 'found mirage' ---")
  r = await ws.shell('grep -m 1 mirage /gdrive/mirage/example.jsonl && echo found')
  console.log(`  Exit code: ${String(r.exitCode)}`)
  console.log(`  Stdout ends with: ...${r.stdoutText.trim().slice(-30)}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── || chain: grep nonexistent || echo fallback ──
  console.log("\n--- grep NONEXISTENT /gdrive/mirage/example.jsonl || echo 'not found' ---")
  r = await ws.shell('grep NONEXISTENT /gdrive/mirage/example.jsonl || echo not_found')
  console.log(`  Exit code: ${String(r.exitCode)}`)
  console.log(`  Output: ${r.stdoutText.trim()}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── subshell: (grep | sort | uniq) | wc -l ──
  console.log('\n--- (grep queue-operation /gdrive/mirage/example.jsonl | sort | uniq) | wc -l ---')
  r = await ws.shell('(grep queue-operation /gdrive/mirage/example.jsonl | sort | uniq) | wc -l')
  console.log(`  Unique queue ops: ${r.stdoutText.trim()}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── semicolon: multiple independent reads ──
  console.log(
    '\n--- head -n 1 /gdrive/mirage/example.jsonl ; wc -l /gdrive/mirage/example.jsonl ---',
  )
  r = await ws.shell('head -n 1 /gdrive/mirage/example.jsonl ; wc -l /gdrive/mirage/example.jsonl')
  console.log(`  Output: ${r.stdoutText.trim()}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── lazy multi-pipe: grep | grep | head | cut ──
  console.log('\n--- lazy multi-pipe: grep | grep -v | head | cut ---')
  r = await ws.shell(
    'grep queue-operation /gdrive/mirage/example.jsonl | grep -v error | head -n 2 | cut -d , -f 1',
  )
  console.log(`  Output:\n    ${r.stdoutText.trim()}`)

  const fullLines = lines(
    await out('grep queue-operation /gdrive/mirage/example.jsonl | grep -v error | cut -d , -f 1'),
  )
  console.log(`  Without head: ${String(fullLines.length)} lines (full download)`)

  // ── recursive search ──
  console.log('\n--- rg -l mirage /gdrive/mirage ---')
  found = lines(await out('rg -l mirage /gdrive/mirage'))
  console.log(`  Files: ${JSON.stringify(found)}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── Google native files: docs, sheets, slides ──
  console.log('\n=== GOOGLE NATIVE FILES ===\n')

  console.log('--- ls /gdrive (find native files) ---')
  r = await ws.shell('ls /gdrive/ | head -n 20')
  console.log(`  ${r.stdoutText.trim()}`)

  console.log('\n--- grep in Google Docs (.gdoc.json) ---')
  const listing = lines(await out('ls /gdrive/')).map((f) => f.trim())
  const gdoc = listing.find((f) => f.includes('.gdoc.json'))
  if (gdoc !== undefined) {
    console.log(`  Found doc: ${gdoc}`)
    const grepped = (await out(`grep -i "title" ${shellQuote(`/gdrive/${gdoc}`)}`)).trim()
    if (grepped !== '') console.log(`  grep title: ${grepped.slice(0, 120)}...`)
    console.log(`  Stats: ${opsSummary()}`)
  } else {
    console.log('  No .gdoc.json found in /gdrive/')
  }

  const gsheet = listing.find((f) => f.includes('.gsheet.json'))
  if (gsheet !== undefined) {
    console.log('\n--- grep in Google Sheets (.gsheet.json) ---')
    console.log(`  Found sheet: ${gsheet}`)
    const grepped = (
      await out(`grep -i "properties" ${shellQuote(`/gdrive/${gsheet}`)} | head -n 3`)
    ).trim()
    if (grepped !== '') console.log(`  grep properties: ${grepped.slice(0, 120)}...`)
    console.log(`  Stats: ${opsSummary()}`)
  }

  const gslide = listing.find((f) => f.includes('.gslide.json'))
  if (gslide !== undefined) {
    console.log('\n--- grep in Google Slides (.gslide.json) ---')
    console.log(`  Found slide: ${gslide}`)
    const grepped = (
      await out(`grep -i "slide" ${shellQuote(`/gdrive/${gslide}`)} | head -n 3`)
    ).trim()
    if (grepped !== '') console.log(`  grep slide: ${grepped.slice(0, 120)}...`)
    console.log(`  Stats: ${opsSummary()}`)
  }

  // ── mixed file type grep ──
  console.log('\n=== MIXED FILE TYPE GREP ===\n')

  console.log('--- grep -c title in Google Doc (eager read) ---')
  if (gdoc !== undefined) {
    r = await ws.shell(`grep -c title ${shellQuote(`/gdrive/${gdoc}`)}`)
    console.log(`  ${gdoc}: ${r.stdoutText.trim()} matches`)
  }

  console.log('\n--- grep in regular file (streaming) ---')
  r = await ws.shell('grep -c queue-operation /gdrive/mirage/example.jsonl')
  console.log(`  example.jsonl: ${r.stdoutText.trim()} matches`)

  console.log('\n--- rg across mirage folder (regular files) ---')
  found = lines(await out('rg -l queue /gdrive/mirage/'))
  console.log(`  Files matching 'queue': ${JSON.stringify(found)}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── jq: structured JSON queries ──
  console.log('\n=== JQ QUERIES ===\n')

  const jqQueries: [string, string][] = [
    ['--- jq .metadata ---', 'jq .metadata /gdrive/mirage/example.json'],
    [
      '\n--- jq: all team names (nested [] iterator) ---',
      'jq ".departments[].teams[].name" /gdrive/mirage/example.json',
    ],
    [
      '\n--- jq: all employee names ---',
      'jq ".departments[].teams[].members[].name" /gdrive/mirage/example.json',
    ],
    [
      '\n--- jq: senior engineers on platform ---',
      'jq ".departments[0].teams[0].members | map(select(.level == \\"senior\\")) | map(.name)" /gdrive/mirage/example.json',
    ],
    [
      '\n--- jq: all active project names ---',
      'jq ".departments[].teams[].projects | map(select(.status == \\"active\\")) | map(.name)" /gdrive/mirage/example.json',
    ],
    [
      '\n--- jq: mirage project metrics ---',
      'jq .departments[0].teams[0].projects[0].metrics /gdrive/mirage/example.json',
    ],
  ]
  for (const [header, cmd] of jqQueries) {
    console.log(header)
    console.log(`  ${(await out(cmd)).trim()}`)
  }

  console.log('\n--- jq: total budget ---')
  const budget = (await out('jq .metadata.total_budget /gdrive/mirage/example.json')).trim()
  if (budget !== '') {
    console.log(`  Total budget: $${Number.parseInt(budget, 10).toLocaleString('en-US')}`)
  } else {
    console.log('  (no output)')
  }

  for (const [header, cmd] of [
    [
      '\n--- jq: vendor costs ---',
      'jq ".vendor_contracts | map(.annual_cost)" /gdrive/mirage/example.json',
    ],
    ['\n--- jq: office locations ---', 'jq ".locations | map(.city)" /gdrive/mirage/example.json'],
    [
      '\n--- jq: all incident titles ---',
      'jq ".departments[].teams[].incidents[].title" /gdrive/mirage/example.json',
    ],
    [
      '\n--- jq: OKR key results ---',
      'jq ".okrs[0].objectives[0].key_results | map(.description)" /gdrive/mirage/example.json',
    ],
  ] as const) {
    console.log(header)
    console.log(`  ${(await out(cmd)).trim()}`)
  }

  console.log('\n--- pipe: cat | jq (from cache) ---')
  r = await ws.shell('cat /gdrive/mirage/example.json | jq .metadata.version')
  console.log(`  Version: ${r.stdoutText.trim()}`)

  // ── session: cd + export ──
  console.log('\n=== SESSION: cd + export ===\n')

  console.log('--- cd /gdrive/mirage && ls ---')
  await ws.shell('cd /gdrive/mirage')
  console.log(`  ${(await out('ls')).trim()}`)

  console.log('\n--- export + variable expansion ---')
  await ws.shell('export SEARCH=mirage')
  console.log(`  ${(await out('grep $SEARCH example.jsonl | head -n 2')).trim().slice(0, 80)}...`)

  console.log('\n--- printenv ---')
  console.log(`  ${(await out('printenv')).trim()}`)

  // ── execution history: hidden recorder + GNU views ──
  console.log('\n=== EXECUTION HISTORY ===\n')
  const events = await ws.history()
  console.log(`  Total commands recorded: ${String(events.length)}`)

  const entry = events.at(-1)!
  console.log(`\n  Last command: ${String(entry.command)}`)
  console.log(`  Session: ${String(entry.session)}`)
  console.log(`  Exit code: ${String(entry.exit_code)}`)

  console.log('\n  --- history (shell builtin, this session) ---')
  for (const line of lines(await out('history 5'))) console.log(`  ${line.slice(0, 100)}`)

  console.log('\n  --- tail -n 6 /.bash_history (all sessions, GNU file) ---')
  for (const line of lines(await out('tail -n 6 /.bash_history')))
    console.log(`  ${line.slice(0, 100)}`)

  console.log('\n  --- history as JSONL ---')
  for (const e of events.slice(-3)) console.log(JSON.stringify(e))

  // ── background jobs: & operator ──
  console.log('\n=== BACKGROUND JOBS ===\n')

  console.log('--- launch two background greps (-q: a status, no output) ---')
  r = await ws.shell(
    'grep -q mirage /gdrive/mirage/example.jsonl & grep -q queue-operation /gdrive/mirage/example.jsonl &',
  )
  console.log(`  Output: ${r.stdoutText.trim()}`)

  console.log('\n--- ps: show running jobs ---')
  console.log(`  ${(await out('ps u')).trim()}`)

  console.log('\n--- jobs: list all ---')
  console.log(`  ${(await out('jobs')).trim()}`)

  console.log("\n--- wait %1: the first grep's exit status ---")
  r = await ws.shell('wait %1')
  console.log(`  exit_code: ${String(r.exitCode)}`)

  console.log("\n--- wait %2: the second grep's exit status ---")
  r = await ws.shell('wait %2')
  console.log(`  exit_code: ${String(r.exitCode)}`)

  console.log('\n--- background pipe: its output reaches the line that waits ---')
  r = await ws.shell('grep queue-operation /gdrive/mirage/example.jsonl | head -n 3 & wait $!')
  console.log(`  Output:\n    ${r.stdoutText.trim()}`)

  console.log('\n--- kill demo ---')
  r = await ws.shell('grep mirage /gdrive/mirage/example.jsonl & kill $!; wait $!')
  console.log(`  Exit code after kill: ${String(r.exitCode)}`)

  console.log('\n--- wait || fallback pattern ---')
  found = lines(
    await out(
      'grep NONEXISTENT /gdrive/mirage/example.jsonl & miss=$!; grep mirage /gdrive/mirage/example.jsonl & hit=$!; wait $miss || wait $hit',
    ),
  )
  console.log(`  Fallback matches: ${String(found.length)}`)

  console.log('\n--- jobs after all done ---')
  console.log(`  ${(await out('jobs')).trim() || '(empty)'}`)

  console.log('\n--- background job history ---')
  const bgEntries = (await ws.history()).filter((e) => {
    const cmd = String(e.command)
    return cmd.includes('grep') && !cmd.includes('&')
  })
  console.log(`  Background job records: ${String(bgEntries.length)}`)
  for (const e of bgEntries.slice(-4)) {
    console.log(`    ${String(e.command).slice(0, 60)}  exit=${String(e.exit_code)}`)
  }

  // ── bash history view ──
  console.log('\n=== BASH HISTORY ===\n')

  console.log('--- ls -a / (dotfile view) ---')
  console.log(`  ${(await out('ls -a /')).trim()}`)

  console.log('\n--- grep grep /.bash_history | head -n 3 ---')
  for (const line of lines(await out('grep grep /.bash_history | head -n 3'))) {
    console.log(`  ${line.slice(0, 120)}`)
  }
}

main()
  .catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => ws.close())
