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
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  HfBucketsVFS,
  MountMode,
  Workspace,
  type FileStat,
  type HfBucketsConfig,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function buildConfig(): HfBucketsConfig {
  const bucket = process.env.HF_BUCKET_NAME
  const token = process.env.HF_TOKEN
  if (bucket === undefined || token === undefined) {
    throw new Error('HF_BUCKET_NAME and HF_TOKEN are required')
  }
  return { bucket, token }
}

const vfs = new HfBucketsVFS(buildConfig())
const ws = new Workspace({ '/hf/': vfs }, { mode: MountMode.WRITE })

function opsSummary(): string {
  const records = ws.records
  const total = records.reduce((sum, r) => sum + r.bytes, 0)
  return `${String(records.length)} ops, ${String(total)} bytes transferred`
}

async function run(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const r = await ws.shell(command)
  return { stdout: r.stdoutText, stderr: r.stderrText, exitCode: r.exitCode }
}

async function measure(label: string, cmd: string): Promise<void> {
  const before = ws.records.reduce((sum, rec) => sum + rec.bytes, 0)
  const t0 = performance.now()
  const res = await run(cmd)
  const dt = (performance.now() - t0) / 1000
  const net = ws.records.reduce((sum, rec) => sum + rec.bytes, 0) - before
  const head = res.stdout
    .trim()
    .split('\n')
    .filter((l) => l !== '')
  const first = (head[0] ?? '').slice(0, 48)
  console.log(
    `  ${label.padEnd(42)} bytes=${net.toLocaleString('en-US').padStart(10)}  ` +
      `t=${dt.toFixed(2).padStart(4)}s  lines=${String(head.length).padStart(4)}  ` +
      `out0=${JSON.stringify(first)}`,
  )
}

async function main(): Promise<void> {
  try {
    console.log('=== not-found errors show the full virtual path ===')
    for (const cmd of [
      'cat /hf/__nf_missing__.txt',
      'head /hf/__nf_missing__.txt',
      'stat /hf/__nf_missing__.txt',
    ]) {
      const result = await run(cmd)
      console.log(`$ ${cmd}`)
      console.log(`  exit=${String(result.exitCode)}  ${result.stderr.trim()}`)
    }

    // ── discover structure ────────────────────────────
    console.log('=== ls /hf/ ===')
    console.log((await run('ls /hf/')).stdout)

    // ── tree ──────────────────────────────────────────
    console.log('=== tree /hf/ ===')
    console.log((await run('tree /hf/')).stdout)

    // ── stat (root + file) ──────────────────────────────
    console.log('=== stat /hf (root) ===')
    console.log(`  ${(await run('stat /hf')).stdout.trim()}`)

    console.log('\n=== stat /hf/example.json ===')
    console.log(`  ${(await run('stat /hf/example.json')).stdout.trim()}`)

    // ── cat json ──────────────────────────────────────
    console.log('\n=== cat /hf/example.json | head -n 10 ===')
    console.log((await run('cat /hf/example.json | head -n 10')).stdout)

    // ── head / tail on jsonl ──────────────────────────
    console.log('=== head -n 3 /hf/example.jsonl ===')
    console.log((await run('head -n 3 /hf/example.jsonl')).stdout.slice(0, 300))

    console.log('\n=== tail -n 2 /hf/example.jsonl ===')
    console.log((await run('tail -n 2 /hf/example.jsonl')).stdout.slice(0, 300))

    // ── wc ────────────────────────────────────────────
    console.log('\n=== wc -l /hf/example.jsonl ===')
    console.log(`  ${(await run('wc -l /hf/example.jsonl')).stdout.trim()}`)

    // ── grep ──────────────────────────────────────────
    console.log('\n=== grep -c mirage /hf/example.jsonl ===')
    console.log(`  count: ${(await run('grep -c mirage /hf/example.jsonl')).stdout.trim()}`)

    console.log('\n=== grep mirage /hf/example.jsonl | head -n 3 ===')
    const grepOut = (await run('grep mirage /hf/example.jsonl | head -n 3')).stdout
    for (const ln of grepOut.trim().split('\n')) console.log(`  ${ln.slice(0, 100)}...`)

    // ── find ──────────────────────────────────────────
    console.log("\n=== find /hf/ -name '*.json' ===")
    console.log((await run("find /hf/ -name '*.json'")).stdout)

    console.log("=== find /hf/ -name '*.parquet' ===")
    console.log((await run("find /hf/ -name '*.parquet'")).stdout)

    // ── jq ────────────────────────────────────────────
    console.log('=== jq .metadata /hf/example.json ===')
    console.log(`  ${(await run('jq .metadata /hf/example.json')).stdout.trim().slice(0, 200)}`)

    console.log("\n=== jq -r '.departments[].teams[].name' /hf/example.json ===")
    console.log(`  ${(await run('jq ".departments[].teams[].name" /hf/example.json')).stdout.trim()}`)

    // ── pipelines ─────────────────────────────────────
    console.log('\n=== cat example.jsonl | grep queue-operation | sort | uniq | wc -l ===')
    console.log(
      `  unique lines: ${(await run('cat /hf/example.jsonl | grep queue-operation | sort | uniq | wc -l')).stdout.trim()}`,
    )

    // ── cd + relative paths ───────────────────────────
    console.log('\n=== pwd ===')
    console.log(`  ${(await run('pwd')).stdout.trim()}`)

    console.log('\n=== cd /hf ===')
    console.log(`  exit=${String((await run('cd /hf')).exitCode)}`)

    console.log('\n=== pwd (after cd) ===')
    console.log(`  ${(await run('pwd')).stdout.trim()}`)

    console.log('\n=== ls (relative) ===')
    console.log((await run('ls')).stdout)

    console.log('=== head -n 3 example.json (relative) ===')
    console.log((await run('head -n 3 example.json')).stdout)

    // ── streaming & barrier scenarios ─────────────────
    console.log('\n=== cat | grep | head (streaming drain) ===')
    const streamed = (await run('cat /hf/example.jsonl | grep queue | head -n 3')).stdout
    console.log(`  got ${String(streamed.trim().split('\n').length)} lines (expected 3)`)

    console.log('\n=== grep -q && echo (barrier VALUE) ===')
    let r = await run('grep -q queue /hf/example.jsonl && echo "found"')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${String(r.exitCode)}`)

    console.log('\n=== grep -q || echo (barrier OR) ===')
    r = await run('grep -q NONEXISTENT_STRING /hf/example.jsonl || echo "not found"')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${String(r.exitCode)}`)

    console.log('\n=== grep ; grep (semicolon materialization) ===')
    r = await run('grep -c queue /hf/example.jsonl; grep -c mirage /hf/example.jsonl')
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== grep missing ; echo $? (semicolon exit code) ===')
    r = await run('grep NONEXISTENT_STRING /hf/example.jsonl; echo $?')
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== cat nonexistent 2>&1 | head (stderr in pipe) ===')
    r = await run('cat /hf/nonexistent_file 2>&1 | head -n 1')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${String(r.exitCode)}`)

    console.log('\n=== cat nonexistent | cat (no merge: error in stderr) ===')
    r = await run('cat /hf/nonexistent_file | cat')
    console.log(`  stdout: '${r.stdout.trim()}' (expect empty)`)
    console.log(`  stderr: '${r.stderr.trim().slice(0, 80)}'`)

    console.log('\n=== cat nonexistent 2>&1 | cat (no double-emit) ===')
    r = await run('cat /hf/nonexistent_file 2>&1 | cat')
    console.log(`  stdout: '${r.stdout.trim().slice(0, 80)}'`)
    console.log(`  stderr: '${r.stderr.trim()}' (expect empty: no double-emit)`)

    console.log('\n=== cat large 2>&1 | wc -l (streams real payload) ===')
    const wcRes = await run('wc -l /hf/example.jsonl')
    const expected = Number.parseInt(wcRes.stdout.trim().split(/\s+/)[0] ?? '0', 10)
    const mergedRes = await run('cat /hf/example.jsonl 2>&1 | wc -l')
    const got = Number.parseInt(mergedRes.stdout.trim(), 10)
    console.log(
      `  expected: ${String(expected)}  got: ${String(got)}  ${got === expected ? 'OK' : 'MISMATCH'}`,
    )

    console.log('\n=== cat | sort | uniq | wc -l (full pipeline) ===')
    r = await run('cat /hf/example.jsonl | sort | uniq | wc -l')
    console.log(`  unique lines: ${r.stdout.trim()}`)

    // ── background job scenarios ────────────────────
    console.log('\n=== grep -c & echo kicked off; wait (bg job) ===')
    r = await run("grep -c queue /hf/example.jsonl & echo 'kicked off'; wait")
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log("\n=== sleep 0 & cat (bg doesn't consume stdin) ===")
    r = await run('sleep 0 & cat /hf/example.json | head -n 1')
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== cat nonexistent & echo ok (bg error handled) ===')
    r = await run('cat /hf/nonexistent_file & echo ok; wait; echo done')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${String(r.exitCode)}`)

    console.log('\n=== multiple bg: grep & wc & wait (parallel) ===')
    r = await run(
      'grep -c queue /hf/example.jsonl & wc -l /hf/example.jsonl & wait; echo all done',
    )
    console.log(`  stdout: ${r.stdout.trim()}`)

    // ── lazy stdin in loops ───────────────────────────
    console.log('\n=== head -n 5 | while read; do echo (bounded loop) ===')
    r = await run(
      'cat /hf/example.jsonl | head -n 5 | while read LINE; do echo got; done | wc -l',
    )
    console.log(`  iterations: ${r.stdout.trim()} (expected 5)`)

    console.log('\n=== while read; break (early exit) ===')
    r = await run(
      'cat /hf/example.jsonl | head -n 100 | while read LINE; do echo first; break; done',
    )
    const firstLines = r.stdout.trim().split('\n')
    console.log(
      `  stdout lines: ${String(firstLines.length)} (expected 1)  exit=${String(r.exitCode)}`,
    )

    console.log('\n=== for x in a b c; do read LINE (loop reads buffer) ===')
    r = await run(
      'cat /hf/example.jsonl | head -n 3 | for x in a b c; do read LINE; echo "$x:${LINE:0:30}"; done',
    )
    for (const line of r.stdout.trim().split('\n')) console.log(`  ${line}`)

    // ── quoting / escaping ────────────────────────────
    console.log('\n=== echo "\\$X" (escaped dollar stays literal) ===')
    await run('export X=expanded')
    r = await run('echo "\\$X"')
    console.log(`  stdout: ${JSON.stringify(r.stdout.trim())} (expect '$X')`)

    console.log('\n=== echo "$X" (unescaped dollar expands) ===')
    r = await run('echo "$X"')
    console.log(`  stdout: ${JSON.stringify(r.stdout.trim())} (expect 'expanded')`)

    console.log("\n=== echo '$X' (single quotes keep $X literal) ===")
    r = await run("echo '$X'")
    console.log(`  stdout: ${JSON.stringify(r.stdout.trim())} (expect '$X')`)

    console.log('\n=== cat "$DIR/example.json" (env var in path) ===')
    await run('export DIR=/hf')
    r = await run('cat "$DIR/example.json" | head -n 3')
    console.log(`  first lines: ${JSON.stringify(r.stdout.trim().split('\n'))}`)

    console.log('\n=== cat $(echo /hf/example.json) | head -n 1 (command sub as path) ===')
    r = await run('cat $(echo /hf/example.json) | head -n 1')
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== grep "$(echo queue)" /hf/example.jsonl | wc -l (sub as pattern) ===')
    r = await run('grep "$(echo queue)" /hf/example.jsonl | wc -l')
    console.log(`  count: ${r.stdout.trim()}`)

    // ── chunk-level streaming + multi-stage pipe backpressure ─────────
    console.log('\n=== STREAMING (single command) ===')
    const target = '/hf/example.jsonl'
    r = await run(`stat -c '%s' ${target}`)
    const size = Number.parseInt(r.stdout.trim(), 10)
    console.log(`  object size: ${size.toLocaleString('en-US')} bytes`)

    await ws.cache.clear()
    await measure('head -n 1 (line-streamed)', `head -n 1 ${target}`)
    await ws.cache.clear()
    await measure('head -c 100 (byte-range)', `head -c 100 ${target}`)
    await ws.cache.clear()
    await measure('grep -m 1 (early-exit)', `grep -m 1 mirage ${target}`)

    console.log('\n=== STREAMING CHAIN (multi-stage pipe backpressure) ===')
    await ws.cache.clear()
    await measure('cat | head -n 1', `cat ${target} | head -n 1`)
    await ws.cache.clear()
    await measure('cat | tr A-Z a-z | head -n 1', `cat ${target} | tr A-Z a-z | head -n 1`)
    await ws.cache.clear()
    await measure('cat | grep mirage | head -n 1', `cat ${target} | grep mirage | head -n 1`)
    await ws.cache.clear()
    await measure(
      '4-stage: cat|tr|grep|head -n 1',
      `cat ${target} | tr A-Z a-z | grep mirage | head -n 1`,
    )
    await ws.cache.clear()
    await measure(
      '5-stage: cat|tr|grep|head|wc -l',
      `cat ${target} | tr A-Z a-z | grep mirage | head -n 1 | wc -l`,
    )
    await ws.cache.clear()
    await measure('non-cancellable: cat | wc -l', `cat ${target} | wc -l`)

    // WRITE + REMOVE flow. HF Buckets silently drops zero-byte uploads,
    // so we use ws.vfs.write to push non-empty bytes (touch would no-op).
    // Demonstrates parent-dir index cache invalidation: without it, `ls`
    // after a write would return stale entries.
    const testFile = `/hf/test-${randomUUID().replaceAll('-', '').slice(0, 8)}.txt`
    console.log(`\n=== WRITE + REMOVE FLOW (using ${testFile}) ===`)

    console.log(`\n--- write '${testFile}' (14 bytes) ---`)
    await ws.vfs.write(testFile, new TextEncoder().encode('Hello, Mirage!'))
    console.log('  written')

    console.log(`\n--- stat ${testFile} (should succeed) ---`)
    r = await run(`stat ${testFile}`)
    console.log(`  ${r.stdout.trim()}`)

    console.log(`\n--- cat ${testFile} ---`)
    r = await run(`cat ${testFile}`)
    console.log(`  ${JSON.stringify(r.stdout.trim())}`)

    console.log(`\n--- rm ${testFile} ---`)
    r = await run(`rm ${testFile}`)
    console.log(`  exit: ${String(r.exitCode)}`)

    console.log(`\n--- stat ${testFile} (should fail: not found) ---`)
    r = await run(`stat ${testFile}`)
    console.log(`  exit: ${String(r.exitCode)}  stderr: ${r.stderr.trim().slice(0, 80)}`)

    // touch on an existing file is still tested (no-op when c=False but
    // file exists, since exists() short-circuits).
    console.log('\n--- touch on existing file (no-op) ---')
    r = await run('touch /hf/example.json')
    console.log(`  exit: ${String(r.exitCode)}`)

    // chmod/chown/touch never hit the Hub API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log('=== metadata overlay on /hf/example.json ===')
    const metaRes = await ws.shell(
      'chmod 640 "/hf/example.json" && chown 500:dev "/hf/example.json" && touch -t 202601021530 "/hf/example.json"',
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', '/hf/example.json')) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    console.log(`\nStats: ${opsSummary()}`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
