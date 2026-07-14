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
import { MountMode, OCIResource, Workspace, type FileStat, type OCIConfig } from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function configFromEnv(): OCIConfig {
  const bucket = process.env.OCI_BUCKET
  const namespace = process.env.OCI_NAMESPACE
  const region = process.env.OCI_REGION
  const accessKeyId = process.env.OCI_ACCESS_KEY_ID
  const secretAccessKey = process.env.OCI_SECRET_ACCESS_KEY
  if (
    bucket === undefined ||
    namespace === undefined ||
    region === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    throw new Error(
      'OCI_BUCKET, OCI_NAMESPACE, OCI_REGION, OCI_ACCESS_KEY_ID, OCI_SECRET_ACCESS_KEY must be set (e.g. in .env.development)',
    )
  }
  const endpoint = process.env.OCI_ENDPOINT_URL
  return {
    bucket,
    namespace,
    region,
    accessKeyId,
    secretAccessKey,
    ...(endpoint !== undefined ? { endpoint } : {}),
  }
}

async function run(
  ws: Workspace,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const r = await ws.execute(command)
  return {
    stdout: r.stdoutText,
    stderr: r.stderrText,
    exitCode: r.exitCode,
  }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const resource = new OCIResource(config)
  const ws = new Workspace({ '/oci/': resource }, { mode: MountMode.READ })

  try {
    console.log('=== ls /oci/ ===')
    console.log((await run(ws, 'ls /oci/')).stdout)

    console.log('=== ls /oci/data/ ===')
    console.log((await run(ws, 'ls /oci/data/')).stdout)

    console.log('=== tree /oci/ ===')
    console.log((await run(ws, 'tree /oci/')).stdout)

    console.log('=== stat /oci/data (directory prefix) ===')
    console.log(`  ${(await run(ws, 'stat /oci/data')).stdout.trim()}`)

    console.log('\n=== stat /oci/data/example.json ===')
    console.log(`  ${(await run(ws, 'stat /oci/data/example.json')).stdout.trim()}`)

    console.log('\n=== cat /oci/data/example.json | head -n 10 ===')
    console.log((await run(ws, 'cat /oci/data/example.json | head -n 10')).stdout)

    console.log('=== head -n 3 /oci/data/example.jsonl ===')
    console.log((await run(ws, 'head -n 3 /oci/data/example.jsonl')).stdout.slice(0, 300))

    console.log('\n=== tail -n 2 /oci/data/example.jsonl ===')
    console.log((await run(ws, 'tail -n 2 /oci/data/example.jsonl')).stdout.slice(0, 300))

    console.log('\n=== wc -l /oci/data/example.jsonl ===')
    console.log(`  ${(await run(ws, 'wc -l /oci/data/example.jsonl')).stdout.trim()}`)

    console.log('\n=== grep -c mirage /oci/data/example.jsonl ===')
    console.log(`  count: ${(await run(ws, 'grep -c mirage /oci/data/example.jsonl')).stdout.trim()}`)

    console.log('\n=== grep mirage /oci/data/example.jsonl | head -n 3 ===')
    const grepOut = (await run(ws, 'grep mirage /oci/data/example.jsonl | head -n 3')).stdout
    for (const ln of grepOut.trim().split('\n')) console.log(`  ${ln.slice(0, 100)}...`)

    console.log("\n=== find /oci/ -name '*.json' ===")
    console.log((await run(ws, "find /oci/ -name '*.json'")).stdout)

    console.log("=== find /oci/ -name '*.parquet' ===")
    console.log((await run(ws, "find /oci/ -name '*.parquet'")).stdout)

    console.log('=== jq .metadata /oci/data/example.json ===')
    console.log(`  ${(await run(ws, 'jq .metadata /oci/data/example.json')).stdout.trim().slice(0, 200)}`)

    console.log("\n=== jq '.departments[].teams[].name' /oci/data/example.json ===")
    console.log(
      `  ${(await run(ws, 'jq ".departments[].teams[].name" /oci/data/example.json')).stdout.trim()}`,
    )

    console.log('\n=== cat example.jsonl | grep queue-operation | sort | uniq | wc -l ===')
    console.log(
      `  unique lines: ${(await run(ws, 'cat /oci/data/example.jsonl | grep queue-operation | sort | uniq | wc -l')).stdout.trim()}`,
    )

    console.log('\n=== pwd ===')
    console.log(`  ${(await run(ws, 'pwd')).stdout.trim()}`)

    console.log('\n=== cd /oci/data ===')
    console.log(`  exit=${(await run(ws, 'cd /oci/data')).exitCode}`)

    console.log('\n=== pwd (after cd) ===')
    console.log(`  ${(await run(ws, 'pwd')).stdout.trim()}`)

    console.log('\n=== ls (relative) ===')
    console.log((await run(ws, 'ls')).stdout)

    console.log('=== head -n 3 example.json (relative) ===')
    console.log((await run(ws, 'head -n 3 example.json')).stdout)

    console.log('\n=== cat | grep | head (streaming drain) ===')
    const streamed = (await run(ws, 'cat /oci/data/example.jsonl | grep queue | head -n 3')).stdout
    console.log(`  got ${streamed.trim().split('\n').length} lines (expected 3)`)

    console.log('\n=== grep -q && echo (barrier VALUE) ===')
    let r = await run(ws, 'grep -q queue /oci/data/example.jsonl && echo "found"')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${r.exitCode}`)

    console.log('\n=== grep -q || echo (barrier OR) ===')
    r = await run(ws, 'grep -q NONEXISTENT_STRING /oci/data/example.jsonl || echo "not found"')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${r.exitCode}`)

    console.log('\n=== grep ; grep (semicolon materialization) ===')
    r = await run(
      ws,
      'grep -c queue /oci/data/example.jsonl; grep -c mirage /oci/data/example.jsonl',
    )
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== grep missing ; echo $? (semicolon exit code) ===')
    r = await run(ws, 'grep NONEXISTENT_STRING /oci/data/example.jsonl; echo $?')
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== cat nonexistent 2>&1 | head (stderr in pipe) ===')
    r = await run(ws, 'cat /oci/data/nonexistent_file 2>&1 | head -n 1')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${r.exitCode}`)

    console.log('\n=== cat nonexistent | cat (no merge: error in stderr) ===')
    r = await run(ws, 'cat /oci/data/nonexistent_file | cat')
    console.log(`  stdout: '${r.stdout.trim()}' (expect empty)`)
    console.log(`  stderr: '${r.stderr.trim().slice(0, 80)}'`)

    console.log('\n=== cat nonexistent 2>&1 | cat (no double-emit) ===')
    r = await run(ws, 'cat /oci/data/nonexistent_file 2>&1 | cat')
    console.log(`  stdout: '${r.stdout.trim().slice(0, 80)}'`)
    console.log(`  stderr: '${r.stderr.trim()}' (expect empty: no double-emit)`)

    console.log('\n=== cat large 2>&1 | wc -l (streams real payload) ===')
    const wcRes = await run(ws, 'wc -l /oci/data/example.jsonl')
    const expected = Number.parseInt(wcRes.stdout.trim().split(/\s+/)[0] ?? '0', 10)
    const mergedRes = await run(ws, 'cat /oci/data/example.jsonl 2>&1 | wc -l')
    const got = Number.parseInt(mergedRes.stdout.trim(), 10)
    console.log(`  expected: ${expected}  got: ${got}  ${got === expected ? 'OK' : 'MISMATCH'}`)

    console.log('\n=== cat | sort | uniq | wc -l (full pipeline) ===')
    r = await run(ws, 'cat /oci/data/example.jsonl | sort | uniq | wc -l')
    console.log(`  unique lines: ${r.stdout.trim()}`)

    console.log('\n=== grep -c & echo kicked off; wait (bg job) ===')
    r = await run(ws, "grep -c queue /oci/data/example.jsonl & echo 'kicked off'; wait")
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log("\n=== sleep 0 & cat (bg doesn't consume stdin) ===")
    r = await run(ws, 'sleep 0 & cat /oci/data/example.json | head -n 1')
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== cat nonexistent & echo ok (bg error handled) ===')
    r = await run(ws, 'cat /oci/data/nonexistent_file & echo ok; wait; echo done')
    console.log(`  stdout: ${r.stdout.trim()}`)
    console.log(`  exit: ${r.exitCode}`)

    console.log('\n=== multiple bg: grep & wc & wait (parallel) ===')
    r = await run(
      ws,
      'grep -c queue /oci/data/example.jsonl & wc -l /oci/data/example.jsonl & wait; echo all done',
    )
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== head -n 5 | while read; do echo (bounded loop) ===')
    r = await run(
      ws,
      'cat /oci/data/example.jsonl | head -n 5 | while read LINE; do echo got; done | wc -l',
    )
    console.log(`  iterations: ${r.stdout.trim()} (expected 5)`)

    console.log('\n=== while read; break (early exit) ===')
    r = await run(
      ws,
      'cat /oci/data/example.jsonl | head -n 100 | while read LINE; do echo first; break; done',
    )
    const lines = r.stdout.trim().split('\n')
    console.log(`  stdout lines: ${lines.length} (expected 1)  exit=${r.exitCode}`)

    console.log('\n=== for x in a b c; do read LINE (loop reads buffer) ===')
    r = await run(
      ws,
      'cat /oci/data/example.jsonl | head -n 3 | for x in a b c; do read LINE; echo "$x:${LINE:0:30}"; done',
    )
    for (const ln of r.stdout.trim().split('\n')) console.log(`  ${ln}`)

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
    await run(ws, 'export DIR=/oci/data')
    r = await run(ws, 'cat "$DIR/example.json" | head -n 3')
    console.log(`  first lines: ${JSON.stringify(r.stdout.trim().split('\n'))}`)

    console.log('\n=== cat $(echo /oci/data/example.json) | head -n 1 (command sub as path) ===')
    r = await run(ws, 'cat $(echo /oci/data/example.json) | head -n 1')
    console.log(`  stdout: ${r.stdout.trim()}`)

    console.log('\n=== grep "$(echo queue)" /oci/data/example.jsonl | wc -l (sub as pattern) ===')
    r = await run(ws, 'grep "$(echo queue)" /oci/data/example.jsonl | wc -l')
    console.log(`  count: ${r.stdout.trim()}`)


    // chmod/chown/touch never hit the OCI API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /oci/data/example.jsonl ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/oci/data/example.jsonl" && chown 500:dev "/oci/data/example.jsonl" && touch -t 202601021530 "/oci/data/example.jsonl"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/oci/data/example.jsonl`)) as FileStat
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
