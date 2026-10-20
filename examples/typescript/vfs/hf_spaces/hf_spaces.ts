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

// Read-only Hugging Face Space demo against a public space repo.
// No credentials required. Set HF_SPACE_REPO / HF_TOKEN for private repos.
import { HfSpacesVFS, Workspace, MountMode, type FileStat, type HfRepoConfig } from '@struktoai/mirage-node'

function configFromEnv(): HfRepoConfig {
  return {
    repoId: process.env.HF_SPACE_REPO ?? 'HuggingFaceBio/carbon-demo',
    ...(process.env.HF_TOKEN !== undefined ? { token: process.env.HF_TOKEN } : {}),
  }
}

const vfs = new HfSpacesVFS(configFromEnv())
const ws = new Workspace({ '/s/': vfs }, { mode: MountMode.READ })

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
  console.log(`=== mounted ${vfs.accessor.bucketUri} at /s/ ===`)

  console.log('\n=== not-found errors show the full virtual path ===')
  for (const cmd of [
    'cat /s/__nf_missing__.txt',
    'head /s/__nf_missing__.txt',
    'stat /s/__nf_missing__.txt',
  ]) {
    const r = await ws.shell(cmd)
    console.log(`$ ${cmd}`)
    console.log(`  exit=${String(r.exitCode)}  ${r.stderrText.trim()}`)
  }

  // ── discover structure ──────────────────────────────
  console.log('\n=== ls /s/ ===')
  console.log(await out('ls /s/'))

  console.log('=== ls -lh /s/ ===')
  console.log(await out('ls -lh /s/'))

  console.log('=== tree -L 2 /s/ ===')
  console.log((await out('tree -L 2 /s/')).slice(0, 600))

  // ── stat ────────────────────────────────────────────
  console.log('\n=== stat /s/README.md ===')
  console.log(`  ${(await out('stat /s/README.md')).trim()}`)

  // chmod/chown/touch never hit the Hub API: attrs land in the
  // workspace namespace (durable, snapshot-captured) and merge into
  // dispatch-level stat.
  console.log('=== metadata overlay on /s/README.md ===')
  const metaRes = await ws.shell(
    'chmod 640 "/s/README.md" && chown 500:dev "/s/README.md" && touch -t 202601021530 "/s/README.md"',
  )
  console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
  const metaSt = (await ws.dispatch('stat', '/s/README.md')) as FileStat
  const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
  console.log(
    `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
  )

  // ── find variants ───────────────────────────────────
  console.log('\n=== find /s/ -type d ===')
  console.log(await out('find /s/ -type d'))

  console.log("=== find /s/ -name '*.py' ===")
  console.log(await out("find /s/ -name '*.py'"))

  console.log("=== find /s/ -name '*.html' | wc -l ===")
  console.log(`  html count: ${(await out("find /s/ -name '*.html' | wc -l")).trim()}`)

  console.log('=== find /s/ -maxdepth 1 -type f ===')
  console.log(await out('find /s/ -maxdepth 1 -type f'))

  // ── cat / head / tail / wc ──────────────────────────
  console.log('\n=== cat /s/README.md | head -n 15 ===')
  console.log(await out('cat /s/README.md | head -n 15'))

  console.log('=== wc -l /s/README.md ===')
  console.log(`  ${(await out('wc -l /s/README.md')).trim()}`)

  console.log('=== cat /s/requirements.txt ===')
  console.log((await out("cat /s/requirements.txt 2>/dev/null || echo '(no requirements.txt)'")).trimEnd())

  // ── grep across app code ────────────────────────────
  console.log('\n=== grep -l import /s/*.py ===')
  console.log(await out('grep -l import /s/*.py 2>/dev/null'))

  console.log("=== grep -c '^import\\|^from' /s/app.py ===")
  console.log(`  import lines: ${(await out("grep -c '^import\\|^from' /s/app.py 2>/dev/null || echo 0")).trim()}`)

  console.log('=== grep -ic flask /s/app.py ===')
  console.log(`  flask matches: ${(await out('grep -ic flask /s/app.py 2>/dev/null || echo 0')).trim()}`)

  // ── pipelines ───────────────────────────────────────
  console.log("\n=== find /s/ -name '*.py' | sort | head -n 5 ===")
  console.log(await out("find /s/ -name '*.py' | sort | head -n 5"))

  console.log("=== cat /s/README.md | grep -i '^#' | head -n 10 ===")
  console.log(await out("cat /s/README.md | grep -i '^#' | head -n 10"))

  // ── cd + relative paths ─────────────────────────────
  console.log('=== cd /s; pwd; ls | head ===')
  await ws.shell('cd /s')
  console.log(`  pwd: ${(await out('pwd')).trim()}`)
  console.log(`  ls (relative):\n${(await out('ls | head -n 5')).trimEnd()}`)

  // ── barriers + semicolons ───────────────────────────
  console.log("\n=== grep -q app /s/README.md && echo 'mentions app' ===")
  let r = await ws.shell("grep -q app /s/README.md && echo 'mentions app'")
  console.log(`  stdout: ${r.stdoutText.trim()}  exit: ${String(r.exitCode)}`)

  console.log("=== grep -q nonexistent /s/README.md || echo 'absent' ===")
  r = await ws.shell("grep -q nonexistent /s/README.md || echo 'absent'")
  console.log(`  stdout: ${r.stdoutText.trim()}  exit: ${String(r.exitCode)}`)

  // ── quoting + command substitution ──────────────────
  console.log('\n=== quoting + $() ===')
  await ws.shell('export README=/s/README.md')
  console.log(`  wc -l "$README": ${(await out('wc -l "$README"')).trim()}`)
  console.log(`  head -n 1 $(echo /s/README.md): ${(await out('head -n 1 $(echo /s/README.md)')).trim()}`)

  // ── background jobs ─────────────────────────────────
  console.log('\n=== background: wc + grep in parallel ===')
  console.log(`  stdout: ${(await out("wc -l /s/README.md & grep -c '^#' /s/README.md & wait; echo done")).trim()}`)

  // ── streaming chains ────────────────────────────────
  console.log('\n=== STREAMING (chain backpressure) ===')
  const target = '/s/README.md'

  await ws.cache.clear()
  await measure('head -n 1 (line streamed)', `head -n 1 ${target}`)
  await ws.cache.clear()
  await measure('head -c 100 (byte range)', `head -c 100 ${target}`)
  await ws.cache.clear()
  await measure('cat | head -n 1', `cat ${target} | head -n 1`)
  await ws.cache.clear()
  await measure("cat | grep '^#' | head -n 1", `cat ${target} | grep '^#' | head -n 1`)
  await ws.cache.clear()
  await measure(
    '4-stage: cat|tr|grep|head -n 1',
    `cat ${target} | tr A-Z a-z | grep app | head -n 1`,
  )

  console.log(`\nFinal: ${opsSummary()}`)
}

main()
  .catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => ws.close())
