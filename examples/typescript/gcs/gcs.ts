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

import dotenv from 'dotenv'
import { MountMode, GCSResource, Workspace, type FileStat, type GCSConfig } from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function configFromEnv(): GCSConfig {
  const bucket = process.env.GCS_BUCKET
  const accessKeyId = process.env.GCS_ACCESS_KEY_ID
  const secretAccessKey = process.env.GCS_SECRET_ACCESS_KEY
  if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      'GCS_BUCKET, GCS_ACCESS_KEY_ID, GCS_SECRET_ACCESS_KEY must be set (e.g. in .env.development)',
    )
  }
  return { bucket, accessKeyId, secretAccessKey }
}

async function run(ws: Workspace, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const r = await ws.execute(command)
  return {
    stdout: r.stdoutText,
    stderr: r.stderrText,
    exitCode: r.exitCode,
  }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const resource = new GCSResource(config)
  const ws = new Workspace({ '/gcs/': resource }, { mode: MountMode.READ })

  try {
    // ── discover structure ────────────────────────────
    console.log('=== ls /gcs/ ===')
    console.log((await run(ws, 'ls /gcs/')).stdout)

    console.log('=== ls /gcs/data/ ===')
    console.log((await run(ws, 'ls /gcs/data/')).stdout)

    // ── tree ──────────────────────────────────────────
    console.log('=== tree /gcs/ ===')
    console.log((await run(ws, 'tree /gcs/')).stdout)

    // ── stat (directory prefix + file) ────────────────
    console.log('=== stat /gcs/data (directory prefix) ===')
    console.log(`  ${(await run(ws, 'stat /gcs/data')).stdout.trim()}`)

    console.log('\n=== stat /gcs/data/example.json ===')
    console.log(`  ${(await run(ws, 'stat /gcs/data/example.json')).stdout.trim()}`)

    // ── cat json ──────────────────────────────────────
    console.log('\n=== cat /gcs/data/example.json | head -n 10 ===')
    console.log((await run(ws, 'cat /gcs/data/example.json | head -n 10')).stdout)

    // ── head / tail on jsonl ──────────────────────────
    console.log('=== head -n 3 /gcs/data/example.jsonl ===')
    console.log((await run(ws, 'head -n 3 /gcs/data/example.jsonl')).stdout.slice(0, 300))

    console.log('\n=== tail -n 2 /gcs/data/example.jsonl ===')
    console.log((await run(ws, 'tail -n 2 /gcs/data/example.jsonl')).stdout.slice(0, 300))

    // ── wc ────────────────────────────────────────────
    console.log('\n=== wc -l /gcs/data/example.jsonl ===')
    console.log(`  ${(await run(ws, 'wc -l /gcs/data/example.jsonl')).stdout.trim()}`)

    // ── grep ──────────────────────────────────────────
    console.log('\n=== grep -c mirage /gcs/data/example.jsonl ===')
    console.log(`  count: ${(await run(ws, 'grep -c mirage /gcs/data/example.jsonl')).stdout.trim()}`)

    console.log('\n=== grep mirage /gcs/data/example.jsonl | head -n 3 ===')
    const grepOut = (await run(ws, 'grep mirage /gcs/data/example.jsonl | head -n 3')).stdout
    for (const ln of grepOut.trim().split('\n')) console.log(`  ${ln.slice(0, 100)}...`)

    // ── find ──────────────────────────────────────────
    console.log("\n=== find /gcs/ -name '*.json' ===")
    console.log((await run(ws, "find /gcs/ -name '*.json'")).stdout)

    console.log("=== find /gcs/ -name '*.parquet' ===")
    console.log((await run(ws, "find /gcs/ -name '*.parquet'")).stdout)

    // ── jq ────────────────────────────────────────────
    console.log('=== jq .metadata /gcs/data/example.json ===')
    console.log(`  ${(await run(ws, 'jq .metadata /gcs/data/example.json')).stdout.trim().slice(0, 200)}`)

    console.log("\n=== jq '.departments[].teams[].name' /gcs/data/example.json ===")
    console.log(
      `  ${(await run(ws, 'jq ".departments[].teams[].name" /gcs/data/example.json')).stdout.trim()}`,
    )

    // ── pipelines ─────────────────────────────────────
    console.log('\n=== cat example.jsonl | grep queue-operation | sort | uniq | wc -l ===')
    console.log(
      `  unique lines: ${(await run(ws, 'cat /gcs/data/example.jsonl | grep queue-operation | sort | uniq | wc -l')).stdout.trim()}`,
    )

    // ── cd + relative paths ───────────────────────────
    console.log('\n=== pwd ===')
    console.log(`  ${(await run(ws, 'pwd')).stdout.trim()}`)

    console.log('\n=== cd /gcs/data ===')
    console.log(`  exit=${(await run(ws, 'cd /gcs/data')).exitCode}`)

    console.log('\n=== pwd (after cd) ===')
    console.log(`  ${(await run(ws, 'pwd')).stdout.trim()}`)

    console.log('\n=== ls (relative) ===')
    console.log((await run(ws, 'ls')).stdout)

    console.log('=== head -n 3 example.json (relative) ===')
    console.log((await run(ws, 'head -n 3 example.json')).stdout)

    // ── streaming & barrier scenarios ─────────────────
    console.log('\n=== cat | grep | head (streaming drain) ===')
    const streamed = (await run(ws, 'cat /gcs/data/example.jsonl | grep queue | head -n 3')).stdout
    console.log(`  got ${streamed.trim().split('\n').length} lines (expected 3)`)

    console.log('\n=== grep -q && echo (barrier VALUE) ===')
    let r = await run(ws, 'grep -q queue /gcs/data/example.jsonl && echo "found"')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${r.exitCode}`)

    console.log('\n=== grep -q || echo (barrier OR) ===')
    r = await run(ws, 'grep -q NONEXISTENT_STRING /gcs/data/example.jsonl || echo "not found"')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${r.exitCode}`)

    console.log('\n=== grep ; grep (semicolon materialization) ===')
    r = await run(
      ws,
      'grep -c queue /gcs/data/example.jsonl; grep -c mirage /gcs/data/example.jsonl',
    )
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== grep missing ; echo $? (semicolon exit code) ===')
    r = await run(ws, 'grep NONEXISTENT_STRING /gcs/data/example.jsonl; echo $?')
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== cat nonexistent 2>&1 | head (stderr in pipe) ===')
    r = await run(ws, 'cat /gcs/data/nonexistent_file 2>&1 | head -n 1')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${r.exitCode}`)

    // Without 2>&1: error stays in stderr, stdout empty.
    console.log('\n=== cat nonexistent | cat (no merge: error in stderr) ===')
    r = await run(ws, 'cat /gcs/data/nonexistent_file | cat')
    console.log(`  stdout: '${r.stdout.trim()}' (expect empty)`)
    console.log(`  stderr: '${r.stderr.trim().slice(0, 80)}'`)

    // With 2>&1: no double-emit.
    console.log('\n=== cat nonexistent 2>&1 | cat (no double-emit) ===')
    r = await run(ws, 'cat /gcs/data/nonexistent_file 2>&1 | cat')
    console.log(`  stdout: '${r.stdout.trim().slice(0, 80)}'`)
    console.log(`  stderr: '${r.stderr.trim()}' (expect empty: no double-emit)`)

    // 2>&1 streams stdout chunk-by-chunk through merge.
    console.log('\n=== cat large 2>&1 | wc -l (streams real payload) ===')
    const wcRes = await run(ws, 'wc -l /gcs/data/example.jsonl')
    const expected = Number.parseInt(wcRes.stdout.trim().split(/\s+/)[0] ?? '0', 10)
    const mergedRes = await run(ws, 'cat /gcs/data/example.jsonl 2>&1 | wc -l')
    const got = Number.parseInt(mergedRes.stdout.trim(), 10)
    console.log(`  expected: ${expected}  got: ${got}  ${got === expected ? 'OK' : 'MISMATCH'}`)

    console.log('\n=== cat | sort | uniq | wc -l (full pipeline) ===')
    r = await run(ws, 'cat /gcs/data/example.jsonl | sort | uniq | wc -l')
    console.log(`  unique lines: ${r.stdout.trim()}`)

    // ── background job scenarios ──────────────────────
    console.log('\n=== grep -c & echo kicked off; wait (bg job) ===')
    r = await run(ws, "grep -c queue /gcs/data/example.jsonl & echo 'kicked off'; wait")
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log("\n=== sleep 0 & cat (bg doesn't consume stdin) ===")
    r = await run(ws, 'sleep 0 & cat /gcs/data/example.json | head -n 1')
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== cat nonexistent & echo ok (bg error handled) ===')
    r = await run(ws, 'cat /gcs/data/nonexistent_file & echo ok; wait; echo done')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${r.exitCode}`)

    console.log('\n=== multiple bg: grep & wc & wait (parallel) ===')
    r = await run(
      ws,
      'grep -c queue /gcs/data/example.jsonl & wc -l /gcs/data/example.jsonl & wait; echo all done',
    )
    console.log(`  stdout: ${r.stdout.trim()}`)

    // ── lazy stdin in loops ───────────────────────────
    console.log('\n=== head -n 5 | while read; do echo (bounded loop) ===')
    r = await run(
      ws,
      'cat /gcs/data/example.jsonl | head -n 5 | while read LINE; do echo got; done | wc -l',
    )
    console.log(`  iterations: ${r.stdout.trim()} (expected 5)`)

    console.log('\n=== while read; break (early exit) ===')
    r = await run(
      ws,
      'cat /gcs/data/example.jsonl | head -n 100 | while read LINE; do echo first; break; done',
    )
    const lines = r.stdout.trim().split('\n')
    console.log(`  stdout lines: ${lines.length} (expected 1)  exit=${r.exitCode}`)

    console.log('\n=== for x in a b c; do read LINE (loop reads buffer) ===')
    r = await run(
      ws,
      'cat /gcs/data/example.jsonl | head -n 3 | for x in a b c; do read LINE; echo "$x:${LINE:0:30}"; done',
    )
    for (const ln of r.stdout.trim().split('\n')) console.log(`  ${ln}`)

    console.log('\n  (note: while over unbounded stream caps at 10000 iters)')

    // ── quoting / escaping patterns ───────────────────
    console.log('\n=== echo "\\$X" (escaped dollar stays literal) ===')
    await run(ws, 'export X=expanded')
    r = await run(ws, 'echo "\\$X"')
    console.log(`  stdout: ${JSON.stringify(r.stdout.trim())} (expect '$X')`)

    console.log('\n=== echo "$X" (unescaped dollar expands) ===')
    r = await run(ws, 'echo "$X"')
    console.log(`  stdout: ${JSON.stringify(r.stdout.trim())} (expect 'expanded')`)

    console.log("\n=== echo '$X' (single quotes keep $X literal) ===")
    r = await run(ws, "echo '$X'")
    console.log(`  stdout: ${JSON.stringify(r.stdout.trim())} (expect '$X')`)

    console.log('\n=== cat "$DIR/example.json" (env var in path) ===')
    await run(ws, 'export DIR=/gcs/data')
    r = await run(ws, 'cat "$DIR/example.json" | head -n 3')
    console.log(`  first lines: ${JSON.stringify(r.stdout.trim().split('\n'))}`)

    console.log('\n=== cat $(echo /gcs/data/example.json) | head -n 1 (command sub as path) ===')
    r = await run(ws, 'cat $(echo /gcs/data/example.json) | head -n 1')
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== grep "$(echo queue)" /gcs/data/example.jsonl | wc -l (sub as pattern) ===')
    r = await run(ws, 'grep "$(echo queue)" /gcs/data/example.jsonl | wc -l')
    console.log(`  count: ${r.stdout.trim()}`)

    // ── on-the-fly maxDrainBytes (cancellable cache drain) ────────────
    const target = '/gcs/data/example.jsonl'
    await ws.cache.clear()
    console.log('\n=== max_drain_bytes=1MB then cat | head (drain cancelled) ===')
    ws.maxDrainBytes = 1_000_000
    r = await run(ws, `cat ${target} | head -n 3`)
    console.log(`  head returned ${r.stdout.split('\n').filter((l) => l !== '').length} lines`)
    let drainKeys = [...(ws.cache.drainTasks?.keys() ?? [])]
    console.log(`  drain tasks: ${JSON.stringify(drainKeys)}`)
    for (const k of drainKeys) await ws.cache.drainTasks?.get(k)
    let cached: Uint8Array | null = null
    for (const k of drainKeys) cached = (await ws.cache.get(k)) ?? cached
    console.log(
      `  cache after small budget: ${
        cached !== null
          ? `POPULATED (${cached.byteLength} bytes)`
          : 'EMPTY (drain cancelled, as expected)'
      }`,
    )

    await ws.cache.clear()
    console.log('\n=== max_drain_bytes=None then cat | head (drain completes) ===')
    ws.maxDrainBytes = null
    r = await run(ws, `cat ${target} | head -n 3`)
    console.log(`  head returned ${r.stdout.split('\n').filter((l) => l !== '').length} lines`)
    drainKeys = [...(ws.cache.drainTasks?.keys() ?? [])]
    console.log(`  drain tasks: ${JSON.stringify(drainKeys)}`)
    for (const k of drainKeys) await ws.cache.drainTasks?.get(k)
    cached = null
    for (const k of drainKeys) cached = (await ws.cache.get(k)) ?? cached
    console.log(
      `  cache after unbounded: ${
        cached !== null ? `POPULATED (${cached.byteLength} bytes, as expected)` : 'EMPTY'
      }`,
    )

    // ── chunk-level streaming + multi-stage pipe backpressure ─────────
    console.log('\n=== STREAMING (single command) ===')
    r = await run(ws, `stat -c '%s' ${target}`)
    const size = Number.parseInt(r.stdout.trim(), 10)
    console.log(`  object size: ${size.toLocaleString('en-US')} bytes`)

    const measure = async (label: string, cmd: string): Promise<void> => {
      const before = ws.records.reduce((sum, rec) => sum + rec.bytes, 0)
      const t0 = performance.now()
      const res = await run(ws, cmd)
      const dt = (performance.now() - t0) / 1000
      const net = ws.records.reduce((sum, rec) => sum + rec.bytes, 0) - before
      const head = res.stdout.trim().split('\n').filter((l) => l !== '')
      const first = (head[0] ?? '').slice(0, 48)
      console.log(
        `  ${label.padEnd(42)} bytes=${net.toLocaleString('en-US').padStart(10)}  ` +
          `t=${dt.toFixed(2).padStart(4)}s  lines=${String(head.length).padStart(4)}  ` +
          `out0=${JSON.stringify(first)}`,
      )
    }

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

    const total = ws.records.reduce((sum, rec) => sum + rec.bytes, 0)
    console.log(`\nStats: ${ws.records.length} ops, ${total} bytes transferred`)


    // chmod/chown/touch never hit the GCS API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /gcs/data/example.jsonl ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/gcs/data/example.jsonl" && chown 500:dev "/gcs/data/example.jsonl" && touch -t 202601021530 "/gcs/data/example.jsonl"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/gcs/data/example.jsonl`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
