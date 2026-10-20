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

import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  ContentDriftError,
  DriftPolicy,
  MountMode,
  RAMVFS,
  S3VFS,
  Workspace,
  type FileStat,
  type S3Config,
} from '@struktoai/mirage-node'

const __HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function baseConfig(): S3Config {
  const bucket = process.env.AWS_S3_BUCKET
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      'AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY must be set (e.g. in .env.development)',
    )
  }
  return {
    bucket,
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
  }
}

const config = baseConfig()
const deepConfig: S3Config = { ...config, keyPrefix: 'subdata/subsubdata/' }

const backend = new S3VFS(config)
const deepBackend = new S3VFS(deepConfig)
const ws = new Workspace({ '/s3/': backend, '/deep/': deepBackend }, { mode: MountMode.READ })

function opsSummary(): string {
  return `${String(ws.records.length)} ops, ${String(ws.networkBytes)} net, ${String(ws.cacheBytes)} cache`
}

async function out(cmd: string): Promise<string> {
  return (await ws.shell(cmd)).stdoutText.trim()
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

function shortHex(): string {
  return randomUUID().replaceAll('-', '').slice(0, 8)
}

async function run(cmd: string, label?: string): Promise<string> {
  const r = await ws.shell(cmd)
  const text = r.stdoutText.trim()
  const lines = splitLines(text)
  const head = lines[0] ?? ''
  const more = lines.length > 1 ? ` (+${String(lines.length - 1)} more)` : ''
  console.log(`  $ ${label ?? cmd}\n    ${head.slice(0, 110)}${more}  [exit=${String(r.exitCode)}]`)
  return text
}

async function keyPrefixMount(): Promise<void> {
  // ── keyPrefix mount: multi-segment subpath scoping ──
  // Mounts the same bucket twice: /s3/ unscoped, /deep/ scoped to
  // subdata/subsubdata/. Every operation against /deep/X resolves
  // to s3://bucket/subdata/subsubdata/X with the prefix transparent
  // to the agent.
  console.log('=== KEY_PREFIX MOUNT (subdata/subsubdata/) ===\n')

  console.log(`  keyPrefix = ${JSON.stringify(deepConfig.keyPrefix)}`)
  console.log('  /deep/X  ←→  s3://bucket/subdata/subsubdata/X\n')

  console.log('[listings]')
  await run('ls /deep')
  await run('ls -1 /deep')
  await run('ls -la /deep')

  console.log('\n[stat]')
  await run('stat /deep/example.jsonl')
  await run('stat /deep/example.json')
  await run('stat /deep')

  console.log('\n[exists]')
  await run('test -f /deep/example.jsonl && echo present || echo absent')
  await run('test -f /deep/no-such.txt && echo present || echo absent')
  await run('test -d /deep && echo dir-present')

  console.log('\n[read]')
  await run('head -n 1 /deep/example.jsonl')
  await run('tail -n 1 /deep/example.jsonl')
  await run('wc -l /deep/example.jsonl')
  await run('wc -c /deep/example.json')

  console.log('\n[grep]')
  await run('grep -c mirage /deep/example.jsonl')
  await run('grep -m 1 mirage /deep/example.jsonl')
  await run('grep -i MIRAGE /deep/example.jsonl | wc -l')
  await run('grep -n queue-operation /deep/example.jsonl | head -n 1')
  await run('grep -v queue-operation /deep/example.jsonl | wc -l')

  // ── rg (the formerly-broken double-prefix case) ──
  console.log('\n[rg]')
  await run('rg -l mirage /deep')
  await run('rg -c mirage /deep/example.json')
  await run('rg -n queue-operation /deep/example.jsonl | head -n 1')

  console.log('\n[find / du]')
  await run("find /deep -name '*.json'")
  await run("find /deep -name 'example.*' | wc -l")
  await run('find /deep -type f | wc -l')
  await run('du /deep/example.jsonl')

  console.log('\n[glob]')
  await run('echo /deep/*.json')
  await run('echo /deep/example.*')
  await run('for f in /deep/*.json; do wc -c $f; done')

  // ── jq (validates content equivalence) ──
  console.log('\n[jq]')
  await run('jq .metadata.version /deep/example.json')
  await run("jq '.departments[].teams[].name' /deep/example.json")

  console.log('\n[pipelines]')
  await run('cat /deep/example.jsonl | grep mirage | wc -l')
  await run('grep queue-operation /deep/example.jsonl | head -n 2 | cut -d , -f 1')
  await run('grep -m 1 mirage /deep/example.jsonl && echo found')
  await run('grep ZZZ_NOPE /deep/example.jsonl || echo fallback')

  // ── parity vs /s3/ (same bucket, same object, different mount) ──
  console.log('\n[parity vs /s3/]')
  const a = await out('grep -c mirage /deep/example.jsonl')
  const b = await out('grep -c mirage /s3/subdata/subsubdata/example.jsonl')
  console.log(`  /deep/example.jsonl                       grep -c: ${a}`)
  console.log(`  /s3/subdata/subsubdata/example.jsonl      grep -c: ${b}`)
  console.log(`  parity: ${String(a === b)}`)

  console.log('\n[getState]')
  const state = await deepBackend.getState()
  console.log(`  config.keyPrefix = ${JSON.stringify(state.config.keyPrefix)}`)
  console.log(`  access key       = ${String(state.config.accessKeyId)}`)
}

async function execution(): Promise<void> {
  // ── root listing (tests stat on directory prefixes) ──
  console.log('\n=== ROOT LISTING ===\n')

  console.log('--- ls /s3/ ---')
  console.log(`  ${await out('ls /s3/')}`)

  console.log('\n--- tree -L 1 /s3/ ---')
  console.log(`  ${await out('tree -L 1 /s3/')}`)

  console.log('\n--- stat /s3/data ---')
  console.log(`  ${await out('stat /s3/data')}`)

  // ── caching: one full read warms the file cache ──
  // Read file to populate cache (cat declares cache, wc materializes)
  console.log('\n--- caching: cat /s3/data/example.jsonl | wc -l ---')
  console.log(`  lines: ${await out('cat /s3/data/example.jsonl | wc -l')}`)
  console.log(`  Stats after caching: ${opsSummary()}`)

  console.log('\n=== EXECUTION ===\n')

  console.log('--- grep mirage /s3/data/example.jsonl ---')
  let lines = splitLines(await out('grep mirage /s3/data/example.jsonl'))
  console.log(`  Matches: ${String(lines.length)}`)
  if (lines.length > 0) console.log(`  First: ${(lines[0] ?? '').slice(0, 80)}...`)
  console.log(`  Stats: ${opsSummary()}`)

  console.log('\n--- grep -m 1 mirage /s3/data/example.jsonl ---')
  lines = splitLines(await out('grep -m 1 mirage /s3/data/example.jsonl'))
  console.log(`  Matches: ${String(lines.length)}`)
  console.log(`  Stats: ${opsSummary()}`)

  console.log('\n--- grep mirage /s3/data/example.jsonl | wc -l ---')
  let result = await ws.shell('grep mirage /s3/data/example.jsonl | wc -l')
  console.log(`  Count: ${result.stdoutText.trim()}`)
  console.log(`  Exit code: ${String(result.exitCode)}`)
  console.log(`  Stats: ${opsSummary()}`)

  console.log('\n--- grep mirage /s3/data/example.jsonl | head -n 3 ---')
  lines = splitLines(await out('grep mirage /s3/data/example.jsonl | head -n 3'))
  console.log(`  Lines: ${String(lines.length)}`)
  for (const ln of lines) console.log(`    ${ln.slice(0, 80)}...`)
  console.log(`  Stats: ${opsSummary()}`)

  console.log('\n--- cat /s3/data/example.jsonl | grep queue-operation | sort | uniq ---')
  lines = splitLines(await out('cat /s3/data/example.jsonl | grep queue-operation | sort | uniq'))
  console.log(`  Unique lines: ${String(lines.length)}`)
  console.log(`  Stats: ${opsSummary()}`)

  console.log('\n--- rg queue-operation /s3/data/example.jsonl | head -n 5 | cut -d , -f 2 ---')
  const fields = await out('rg queue-operation /s3/data/example.jsonl | head -n 5 | cut -d , -f 2')
  console.log(`  Fields:\n    ${fields}`)
  console.log(`  Stats: ${opsSummary()}`)

  console.log("\n--- grep -m 1 mirage /s3/data/example.jsonl && echo 'found mirage' ---")
  result = await ws.shell('grep -m 1 mirage /s3/data/example.jsonl && echo found')
  console.log(`  Exit code: ${String(result.exitCode)}`)
  console.log(`  Stdout ends with: ...${result.stdoutText.trim().slice(-30)}`)
  console.log(`  Stats: ${opsSummary()}`)

  console.log("\n--- grep NONEXISTENT /s3/data/example.jsonl || echo 'not found' ---")
  result = await ws.shell('grep NONEXISTENT /s3/data/example.jsonl || echo not_found')
  console.log(`  Exit code: ${String(result.exitCode)}`)
  console.log(`  Output: ${result.stdoutText.trim()}`)
  console.log(`  Stats: ${opsSummary()}`)

  console.log('\n--- (grep queue-operation /s3/data/example.jsonl | sort | uniq) | wc -l ---')
  const unique = await out('(grep queue-operation /s3/data/example.jsonl | sort | uniq) | wc -l')
  console.log(`  Unique queue ops: ${unique}`)
  console.log(`  Stats: ${opsSummary()}`)

  console.log('\n--- head -n 1 /s3/data/example.jsonl ; wc -l /s3/data/example.jsonl ---')
  const both = await out('head -n 1 /s3/data/example.jsonl ; wc -l /s3/data/example.jsonl')
  console.log(`  Output: ${both}`)
  console.log(`  Stats: ${opsSummary()}`)

  // ── lazy multi-pipe: grep | grep | head | cut ──
  // Each pipe stage is an async byte stream. Data streams lazily from
  // S3 through grep → grep → head → cut. When head -n 2 has emitted 2
  // lines it stops pulling, which back-pressures upstream: the second
  // grep stops, the first grep stops, and the S3 download is abandoned
  // early — only a fraction of the file is ever read.
  console.log('\n--- lazy multi-pipe: grep | grep -v | head | cut ---')
  const lazy = await out(
    'grep queue-operation /s3/data/example.jsonl | grep -v error | head -n 2 | cut -d , -f 1',
  )
  console.log(`  Output:\n    ${lazy}`)

  // Compare: same pipeline without head reads the entire file
  const full = splitLines(
    await out('grep queue-operation /s3/data/example.jsonl | grep -v error | cut -d , -f 1'),
  )
  console.log(`  Without head: ${String(full.length)} lines (full S3 download)`)

  console.log('\n--- rg -l mirage /s3/data ---')
  lines = splitLines(await out('rg -l mirage /s3/data'))
  console.log(`  Files: ${JSON.stringify(lines)}`)
  console.log(`  Stats: ${opsSummary()}`)
}

async function jqQueries(): Promise<void> {
  console.log('\n=== JQ QUERIES ===\n')

  console.log('--- jq .metadata ---')
  console.log(`  ${await out('jq .metadata /s3/data/example.json')}`)

  console.log('\n--- jq: all team names (nested [] iterator) ---')
  console.log(`  ${await out('jq ".departments[].teams[].name" /s3/data/example.json')}`)

  console.log('\n--- jq: all employee names ---')
  console.log(`  ${await out('jq ".departments[].teams[].members[].name" /s3/data/example.json')}`)

  console.log('\n--- jq: senior engineers on platform ---')
  console.log(
    `  ${await out(
      'jq ".departments[0].teams[0].members | map(select(.level == \\"senior\\")) | map(.name)" /s3/data/example.json',
    )}`,
  )

  console.log('\n--- jq: all active project names ---')
  console.log(
    `  ${await out(
      'jq ".departments[].teams[].projects | map(select(.status == \\"active\\")) | map(.name)" /s3/data/example.json',
    )}`,
  )

  console.log('\n--- jq: mirage project metrics ---')
  console.log(`  ${await out('jq .departments[0].teams[0].projects[0].metrics /s3/data/example.json')}`)

  console.log('\n--- jq: total budget ---')
  const budget = Number(await out('jq .metadata.total_budget /s3/data/example.json'))
  console.log(`  Total budget: $${budget.toLocaleString('en-US')}`)

  console.log('\n--- jq: vendor costs ---')
  console.log(`  ${await out('jq ".vendor_contracts | map(.annual_cost)" /s3/data/example.json')}`)

  console.log('\n--- jq: office locations ---')
  console.log(`  ${await out('jq ".locations | map(.city)" /s3/data/example.json')}`)

  console.log('\n--- jq: all incident titles ---')
  console.log(`  ${await out('jq ".departments[].teams[].incidents[].title" /s3/data/example.json')}`)

  console.log('\n--- jq: OKR key results ---')
  console.log(
    `  ${await out('jq ".okrs[0].objectives[0].key_results | map(.description)" /s3/data/example.json')}`,
  )

  console.log('\n--- pipe: cat | jq (from cache) ---')
  console.log(`  Version: ${await out('cat /s3/data/example.json | jq .metadata.version')}`)
}

async function sessionAndHistory(): Promise<void> {
  console.log('\n=== SESSION: cd + export ===\n')

  console.log('--- cd /s3/data && ls ---')
  await ws.shell('cd /s3/data')
  console.log(`  ${await out('ls')}`)

  console.log('\n--- export + variable expansion ---')
  await ws.shell('export SEARCH=mirage')
  console.log(`  ${(await out('grep $SEARCH example.jsonl | head -n 2')).slice(0, 80)}...`)

  console.log('\n--- printenv ---')
  console.log(`  ${await out('printenv')}`)

  // ── execution history: hidden recorder + GNU views ──
  console.log('\n=== EXECUTION HISTORY ===\n')
  const events = await ws.history()
  console.log(`  Total commands recorded: ${String(events.length)}`)

  const entry = events.at(-1) ?? {}
  console.log(`\n  Last command: ${String(entry.command)}`)
  console.log(`  Session: ${String(entry.session)}`)
  console.log(`  Exit code: ${String(entry.exit_code)}`)

  console.log('\n  --- history (shell builtin, this session) ---')
  for (const line of splitLines((await ws.shell('history 5')).stdoutText.trimEnd())) {
    console.log(`  ${line.slice(0, 100)}`)
  }

  console.log('\n  --- tail -n 6 /.bash_history (all sessions, GNU file) ---')
  for (const line of splitLines((await ws.shell('tail -n 6 /.bash_history')).stdoutText.trimEnd())) {
    console.log(`  ${line.slice(0, 100)}`)
  }

  console.log('\n  --- history as JSONL ---')
  for (const e of events.slice(-3)) console.log(JSON.stringify(e))
}

async function backgroundJobs(): Promise<void> {
  console.log('\n=== BACKGROUND JOBS ===\n')

  console.log('--- launch two background greps (-q: a status, no output) ---')
  const launched = await out(
    'grep -q mirage /s3/data/example.jsonl & grep -q queue-operation /s3/data/example.jsonl &',
  )
  console.log(`  Output: ${launched}`)

  console.log('\n--- ps: show running jobs ---')
  console.log(`  ${await out('ps u')}`)

  console.log('\n--- jobs: list all ---')
  console.log(`  ${await out('jobs')}`)

  console.log("\n--- wait %1: the first grep's exit status ---")
  console.log(`  exit_code: ${String((await ws.shell('wait %1')).exitCode)}`)

  console.log("\n--- wait %2: the second grep's exit status ---")
  console.log(`  exit_code: ${String((await ws.shell('wait %2')).exitCode)}`)

  console.log('\n--- background pipe: its output reaches the line that waits ---')
  const piped = await out('grep queue-operation /s3/data/example.jsonl | head -n 3 & wait $!')
  console.log(`  Output:\n    ${piped}`)

  console.log('\n--- kill demo ---')
  const killed = await ws.shell('grep mirage /s3/data/example.jsonl & kill $!; wait $!')
  console.log(`  Exit code after kill: ${String(killed.exitCode)}`)

  console.log('\n--- wait || fallback pattern ---')
  const fallback = splitLines(
    await out(
      'grep NONEXISTENT /s3/data/example.jsonl & miss=$!;' +
        ' grep mirage /s3/data/example.jsonl & hit=$!;' +
        ' wait $miss || wait $hit',
    ),
  )
  console.log(`  Fallback matches: ${String(fallback.length)}`)

  console.log('\n--- jobs after all done ---')
  console.log(`  ${(await out('jobs')) || '(empty)'}`)

  console.log('\n--- background job history ---')
  const bgEntries = (await ws.history()).filter((e) => {
    const command = String(e.command)
    return command.includes('grep') && !command.includes('&')
  })
  console.log(`  Background job records: ${String(bgEntries.length)}`)
  for (const e of bgEntries.slice(-4)) {
    console.log(`    ${String(e.command).slice(0, 60)}  exit=${String(e.exit_code)}`)
  }
}

async function globAndBashHistory(): Promise<void> {
  console.log('\n=== GLOB EXPANSION ===\n')

  console.log('--- echo /s3/data/*.jsonl ---')
  console.log(`  ${await out('echo /s3/data/*.jsonl')}`)

  console.log('\n--- ls /s3/data/*.json ---')
  console.log(`  ${await out('ls /s3/data/*.json')}`)

  console.log('\n--- for f in /s3/data/*.json; do wc -l $f; done ---')
  console.log(`  ${await out('for f in /s3/data/*.json; do wc -l $f; done')}`)

  console.log('\n--- grep mirage /s3/data/*.jsonl | head -n 2 ---')
  for (const line of splitLines(await out('grep mirage /s3/data/*.jsonl | head -n 2'))) {
    console.log(`  ${line.slice(0, 100)}`)
  }

  console.log('\n=== BASH HISTORY ===\n')

  console.log('--- ls -a / (dotfile view) ---')
  console.log(`  ${await out('ls -a /')}`)

  console.log('\n--- grep glob /.bash_history | head -n 3 ---')
  for (const line of splitLines(await out('grep glob /.bash_history | head -n 3'))) {
    console.log(`  ${line.slice(0, 120)}`)
  }
}

async function crossMountMove(): Promise<void> {
  // ── cross-mount mv: RAM → S3 (with cleanup) ──
  // Builds a fresh workspace with RAM at /local/ and S3 at /s3/ in
  // WRITE mode. Creates a unique a.txt in RAM via tee, mvs it to S3,
  // verifies it landed there, then removes it from S3 so the bucket
  // is left clean.
  console.log('\n=== CROSS-MOUNT MV: RAM → S3 ===\n')
  const mvWs = new Workspace(
    { '/local/': new RAMVFS(), '/s3/': new S3VFS(config) },
    { mode: MountMode.WRITE },
  )
  const remote = `/s3/_mv_test/${shortHex()}_a.txt`
  const payload = 'hello from RAM\n'
  console.log(`  target: ${remote}`)
  try {
    let r = await mvWs.shell(`echo "${payload.trimEnd()}" | tee /local/a.txt`)
    console.log(`  tee exit=${String(r.exitCode)} (created /local/a.txt)`)

    r = await mvWs.shell(`mv /local/a.txt ${remote}`)
    console.log(`  mv exit=${String(r.exitCode)} stderr=${JSON.stringify(r.stderrText.trim())}`)

    r = await mvWs.shell(`cat ${remote}`)
    const got = r.stdoutText
    console.log(`  S3 read back: ${JSON.stringify(got)} (${got === payload ? 'OK' : 'MISMATCH'})`)

    r = await mvWs.shell('cat /local/a.txt')
    console.log(
      `  RAM source after mv: exit=${String(r.exitCode)} (expect non-zero — file moved away)`,
    )

    // ── metadata on S3 (namespace overlay) ──
    // S3 has no native attr slots, so chmod/chown/touch land in the
    // workspace namespace (durable, snapshot-captured) and merge
    // into dispatch-level stat.
    r = await mvWs.shell(
      `chmod 640 ${remote} && chown 500:dev ${remote} && touch -t 202601021530 ${remote}`,
    )
    console.log(`  chmod/chown/touch exit=${String(r.exitCode)}`)
    const st = (await mvWs.dispatch('stat', remote)) as FileStat
    const mode = st.mode !== null ? st.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${mode} uid=${String(st.uid)} gid=${String(st.gid)} mtime=${String(st.modified)}`,
    )
  } finally {
    let r = await mvWs.shell(`rm ${remote}`)
    console.log(`  cleanup rm exit=${String(r.exitCode)}`)
    r = await mvWs.shell(`cat ${remote}`)
    console.log(`  S3 read after rm: exit=${String(r.exitCode)} (expect non-zero)`)
    await mvWs.close()
  }
}

async function persistence(): Promise<void> {
  // ── persistence: snapshot / load / copy ──
  // S3 with inline creds has redacted config at save time; caller must
  // re-supply a fresh S3VFS through load's overrides.
  console.log('\n=== PERSISTENCE ===\n')
  const tempDir = mkdtempSync(join(tmpdir(), 'mirage-s3-'))
  const snap = join(tempDir, 'snapshot.tar')
  try {
    const size = await ws.snapshot(snap)
    console.log(`  saved → ${snap} (${String(size)} bytes)`)

    // Verify creds are NOT in the raw tar bytes
    const raw = readFileSync(snap)
    const leaked = config.accessKeyId !== undefined && raw.includes(config.accessKeyId)
    console.log(`  creds leaked in tar bytes: ${String(leaked)} (expect false)`)
    console.log(`  '<REDACTED>' present in tar: ${String(raw.includes('<REDACTED>'))} (expect true)`)

    // Loading without overrides must fail fast
    try {
      await Workspace.load(snap)
      console.log('  ✗ load() should have thrown without overrides')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  ✓ load() w/o overrides throws: ${(message.split('\n')[0] ?? '').slice(0, 70)}…`)
    }

    // Load with fresh creds (both mounts were redacted)
    const loaded = await Workspace.load(
      snap,
      {},
      { '/s3/': new S3VFS(config), '/deep/': new S3VFS(deepConfig) },
    )
    try {
      console.log(`  loaded ws ls /s3/: ${(await loaded.shell('ls /s3/')).stdoutText.trim().slice(0, 60)}…`)
    } finally {
      await loaded.close()
    }

    // copy(): in-process, reuses the same S3VFS; both copies
    // see the same bucket
    const cp = await ws.copy()
    try {
      console.log(`  copy() mounts: ${JSON.stringify(cp.mounts().map((m) => m.prefix))}`)
    } finally {
      await cp.close()
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function driftAndPin(): Promise<void> {
  console.log('\n=== DRIFT + VERSION PIN ===\n')
  console.log('  requires bucket versioning enabled:')
  console.log(
    '  aws s3api put-bucket-versioning --bucket <bucket> --versioning-configuration Status=Enabled\n',
  )
  const probe = `/s3/drift-probe-${shortHex()}.txt`
  const driftWs = new Workspace({ '/s3/': new S3VFS(config) }, { mode: MountMode.WRITE })
  const tempDir = mkdtempSync(join(tmpdir(), 'mirage-s3-drift-'))
  const driftSnap = join(tempDir, 'drift.tar')
  try {
    await driftWs.shell(`echo "original" | tee ${probe}`)
    await driftWs.shell(`cat ${probe}`)
    const s = (await driftWs.stat(probe)) as FileStat
    console.log(`  wrote ${probe}`)
    console.log(`  fingerprint=${String(s.fingerprint)}`)
    console.log(
      `  revision   =${String(s.revision)} (${s.revision !== null ? 'versioning on' : 'no versioning'})`,
    )

    const snapSize = await driftWs.snapshot(driftSnap)
    console.log(`  snapshot: ${driftSnap} (${String(snapSize)} bytes)`)

    await driftWs.shell(`echo "mutated" | tee ${probe}`)
    const s2 = (await driftWs.stat(probe)) as FileStat
    console.log(`  mutated on bucket: new revision=${String(s2.revision)}`)

    const loaded = await Workspace.load(
      driftSnap,
      { driftPolicy: DriftPolicy.STRICT },
      { '/s3/': new S3VFS(config) },
    )
    loaded.cache.evictPaths([probe])
    try {
      const served = (await loaded.shell(`cat ${probe}`)).stdoutText.trim()
      const pinnedOk = s.revision !== null && served === 'original'
      const label = pinnedOk
        ? 'OK pin served original'
        : served === 'original'
          ? 'no pin (bucket not versioned?), live fingerprint matched'
          : 'UNEXPECTED'
      console.log(`  STRICT load → served: ${JSON.stringify(served)} (${label})`)
    } catch (err) {
      if (!(err instanceof ContentDriftError)) throw err
      console.log(`  STRICT load raised ContentDriftError as expected: ${err.path}`)
    } finally {
      await loaded.close()
    }
  } finally {
    try {
      await driftWs.shell(`rm ${probe}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  cleanup: rm ${probe} failed: ${message}`)
    }
    await driftWs.close()
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  try {
    await keyPrefixMount()
    await execution()
    await jqQueries()
    await sessionAndHistory()
    await backgroundJobs()
    await globAndBashHistory()
    await crossMountMove()
    await persistence()
    await driftAndPin()
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
