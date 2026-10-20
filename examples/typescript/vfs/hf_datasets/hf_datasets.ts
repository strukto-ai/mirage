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

// Read-only Hugging Face dataset demo against a public dataset repo.
import {
  HfDatasetsVFS,
  Workspace,
  MountMode,
  type FileStat,
  type HfRepoConfig,
} from '@struktoai/mirage-node'

function configFromEnv(): HfRepoConfig {
  return {
    repoId: process.env.HF_DATASET_REPO ?? 'AlienKevin/SWE-ZERO-12M-trajectories',
    ...(process.env.HF_TOKEN !== undefined ? { token: process.env.HF_TOKEN } : {}),
  }
}

const vfs = new HfDatasetsVFS(configFromEnv())
const ws = new Workspace({ '/ds/': vfs }, { mode: MountMode.READ })

function opsSummary(): string {
  const total = ws.records.reduce((sum, rec) => sum + rec.bytes, 0)
  return `${String(ws.records.length)} ops, ${String(total)} bytes transferred`
}

async function out(cmd: string): Promise<string> {
  return (await ws.shell(cmd)).stdoutText
}

async function measure(label: string, cmd: string): Promise<void> {
  const before = ws.records.reduce((sum, rec) => sum + rec.bytes, 0)
  const t0 = performance.now()
  const res = await ws.shell(cmd)
  const dt = (performance.now() - t0) / 1000
  const net = ws.records.reduce((sum, rec) => sum + rec.bytes, 0) - before
  const lines = res.stdoutText.trimEnd().split('\n').filter((l) => l !== '')
  console.log(
    `  ${label.padEnd(38)} bytes=${net.toLocaleString('en-US').padStart(6)}  ` +
      `t=${dt.toFixed(2).padStart(4)}s  lines=${String(lines.length).padStart(3)}`,
  )
}

async function main(): Promise<void> {
  console.log(`=== mounted ${vfs.accessor.bucketUri} at /ds/ ===`)

  console.log('\n=== not-found errors show the full virtual path ===')
  for (const cmd of [
    'cat /ds/__nf_missing__.txt',
    'head /ds/__nf_missing__.txt',
    'stat /ds/__nf_missing__.txt',
  ]) {
    const r = await ws.shell(cmd)
    console.log(`$ ${cmd}`)
    console.log(`  exit=${String(r.exitCode)}  ${r.stderrText.trim()}`)
  }

  // ── discover structure ──────────────────────────────
  console.log('\n=== ls /ds/ ===')
  console.log(await out('ls /ds/'))

  console.log('=== ls -lh /ds/ ===')
  console.log(await out('ls -lh /ds/'))

  console.log('=== tree -L 2 /ds/ ===')
  console.log((await out('tree -L 2 /ds/')).slice(0, 400))

  // ── stat ────────────────────────────────────────────
  console.log('\n=== stat /ds (root) ===')
  console.log(`  ${(await out('stat /ds')).trim()}`)

  console.log('\n=== stat /ds/README.md ===')
  console.log(`  ${(await out('stat /ds/README.md')).trim()}`)

  // chmod/chown/touch never hit the Hub API: attrs land in the
  // workspace namespace (durable, snapshot-captured) and merge into
  // dispatch-level stat.
  console.log('=== metadata overlay on /ds/README.md ===')
  const metaRes = await ws.shell(
    'chmod 640 "/ds/README.md" && chown 500:dev "/ds/README.md" && touch -t 202601021530 "/ds/README.md"',
  )
  console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
  const metaSt = (await ws.dispatch('stat', '/ds/README.md')) as FileStat
  const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
  console.log(
    `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
  )

  // ── find ────────────────────────────────────────────
  console.log("\n=== find /ds/ -name '*.md' ===")
  console.log(await out("find /ds/ -name '*.md'"))

  console.log('=== find /ds/ -type d ===')
  console.log(await out('find /ds/ -type d'))

  console.log("=== find /ds/ -name '*.parquet' | head -n 5 ===")
  console.log(await out("find /ds/ -name '*.parquet' | head -n 5"))

  console.log("=== find /ds/ -name '*.parquet' | wc -l ===")
  console.log(`  parquet shard count: ${(await out("find /ds/ -name '*.parquet' | wc -l")).trim()}`)

  // ── cat / head / tail / wc ──────────────────────────
  console.log('\n=== cat /ds/README.md | head -n 20 ===')
  console.log(await out('cat /ds/README.md | head -n 20'))

  console.log('=== wc -l /ds/README.md ===')
  console.log(`  ${(await out('wc -l /ds/README.md')).trim()}`)

  console.log('=== head -c 200 /ds/README.md (byte range) ===')
  console.log(await out('head -c 200 /ds/README.md'))

  // ── grep ────────────────────────────────────────────
  console.log('\n=== grep -c parquet /ds/README.md ===')
  console.log(`  count: ${(await out('grep -c parquet /ds/README.md')).trim()}`)

  console.log('=== grep -i license /ds/README.md ===')
  console.log(`  ${(await out('grep -i license /ds/README.md')).trim()}`)

  // ── pipelines ───────────────────────────────────────
  console.log("\n=== find /ds/ -name '*.parquet' | sort | head -n 3 ===")
  console.log(await out("find /ds/ -name '*.parquet' | sort | head -n 3"))

  console.log('=== cat /ds/README.md | grep -i tag | head -n 5 ===')
  console.log(await out('cat /ds/README.md | grep -i tag | head -n 5'))

  // ── cd + relative paths ─────────────────────────────
  console.log('=== pwd ===')
  console.log(`  ${(await out('pwd')).trim()}`)

  console.log('=== cd /ds; pwd; ls | head ===')
  await ws.shell('cd /ds')
  console.log(`  pwd: ${(await out('pwd')).trim()}`)
  console.log(`  ls (relative):\n${(await out('ls | head -n 5')).trimEnd()}`)

  // ── barriers + semicolons ───────────────────────────
  console.log("\n=== grep -q parquet /ds/README.md && echo 'found' ===")
  let r = await ws.shell("grep -q parquet /ds/README.md && echo 'found'")
  console.log(`  stdout: ${r.stdoutText.trim()}  exit: ${String(r.exitCode)}`)

  console.log("=== grep -q nope /ds/README.md || echo 'absent' ===")
  r = await ws.shell("grep -q nope /ds/README.md || echo 'absent'")
  console.log(`  stdout: ${r.stdoutText.trim()}  exit: ${String(r.exitCode)}`)

  console.log('=== grep -c parquet README ; wc -l README (semicolon) ===')
  console.log(`  stdout: ${(await out('grep -c parquet /ds/README.md; wc -l /ds/README.md')).trim()}`)

  // ── quoting / escaping / command substitution ───────
  console.log('\n=== quoting / $(...) / env vars ===')
  await ws.shell('export TGT=/ds/README.md')
  console.log(`  cat "$TGT" | head -n 2:\n${(await out('cat "$TGT" | head -n 2')).trimEnd()}`)
  console.log(`  head -n 1 $(echo /ds/README.md): ${(await out('head -n 1 $(echo /ds/README.md)')).trim()}`)

  // ── background jobs ─────────────────────────────────
  console.log('\n=== background jobs ===')
  console.log(`  stdout: ${(await out("grep -c parquet /ds/README.md & echo 'kicked off'; wait")).trim()}`)
  console.log(
    `  parallel: ${(await out('grep -c parquet /ds/README.md & wc -l /ds/README.md & wait; echo all done')).trim()}`,
  )

  // ── streaming chain backpressure ────────────────────
  console.log('\n=== STREAMING (chain backpressure) ===')
  const target = '/ds/README.md'
  console.log(`  size: ${(await out(`stat -c '%s' ${target}`)).trim()} bytes`)

  await ws.cache.clear()
  await measure('head -n 1 (line streamed)', `head -n 1 ${target}`)
  await ws.cache.clear()
  await measure('head -c 100 (byte range)', `head -c 100 ${target}`)
  await ws.cache.clear()
  await measure('grep -m 1 (early exit)', `grep -m 1 parquet ${target}`)
  await ws.cache.clear()
  await measure('cat | head -n 1', `cat ${target} | head -n 1`)
  await ws.cache.clear()
  await measure('cat | tr A-Z a-z | head -n 1', `cat ${target} | tr A-Z a-z | head -n 1`)
  await ws.cache.clear()
  await measure(
    '4-stage: cat|tr|grep|head -n 1',
    `cat ${target} | tr A-Z a-z | grep parquet | head -n 1`,
  )

  console.log(`\nFinal: ${opsSummary()}`)
}

main()
  .catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => ws.close())
