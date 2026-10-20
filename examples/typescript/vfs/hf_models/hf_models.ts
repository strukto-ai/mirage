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

// Read-only Hugging Face model demo against a public model repo.
// No credentials required. Set HF_MODEL_REPO / HF_TOKEN for private repos.
import { HfModelsVFS, Workspace, MountMode, type FileStat, type HfModelsConfig } from '@struktoai/mirage-node'

function configFromEnv(): HfModelsConfig {
  return {
    repoId: process.env.HF_MODEL_REPO ?? 'sapientinc/HRM-Text-1B',
    ...(process.env.HF_TOKEN !== undefined ? { token: process.env.HF_TOKEN } : {}),
  }
}

const vfs = new HfModelsVFS(configFromEnv())
const ws = new Workspace({ '/m/': vfs }, { mode: MountMode.READ })

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
  const first = lines.length > 0 ? `${lines[0]!.slice(0, 40)}...` : ''
  console.log(
    `  ${label.padEnd(42)} bytes=${net.toLocaleString('en-US').padStart(9)}  ` +
      `t=${dt.toFixed(2).padStart(4)}s  lines=${String(lines.length).padStart(3)}  out0=${JSON.stringify(first)}`,
  )
}

async function main(): Promise<void> {
  console.log(`=== mounted ${vfs.accessor.bucketUri} at /m/ ===`)

  console.log('\n=== not-found errors show the full virtual path ===')
  for (const cmd of [
    'cat /m/__nf_missing__.txt',
    'head /m/__nf_missing__.txt',
    'stat /m/__nf_missing__.txt',
  ]) {
    const r = await ws.shell(cmd)
    console.log(`$ ${cmd}`)
    console.log(`  exit=${String(r.exitCode)}  ${r.stderrText.trim()}`)
  }

  // ── discover structure ──────────────────────────────
  console.log('\n=== ls /m/ ===')
  console.log(await out('ls /m/'))

  console.log('=== ls -lh /m/ (sizes; weights stay remote) ===')
  console.log(await out('ls -lh /m/'))

  console.log('=== tree /m/ ===')
  console.log(await out('tree /m/'))

  // ── stat (root + small + huge file) ─────────────────
  console.log('\n=== stat /m/config.json ===')
  console.log(`  ${(await out('stat /m/config.json')).trim()}`)

  // chmod/chown/touch never hit the Hub API: attrs land in the
  // workspace namespace (durable, snapshot-captured) and merge into
  // dispatch-level stat.
  console.log('=== metadata overlay on /m/config.json ===')
  const metaRes = await ws.shell(
    'chmod 640 "/m/config.json" && chown 500:dev "/m/config.json" && touch -t 202601021530 "/m/config.json"',
  )
  console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
  const metaSt = (await ws.dispatch('stat', '/m/config.json')) as FileStat
  const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
  console.log(
    `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
  )

  console.log('=== stat /m/model.safetensors (no download) ===')
  console.log(`  ${(await out('stat /m/model.safetensors')).trim()}`)

  console.log("=== stat -c '%s' /m/model.safetensors ===")
  console.log(`  weights size (bytes): ${(await out("stat -c '%s' /m/model.safetensors")).trim()}`)

  // ── cat the config (small + fast) ───────────────────
  console.log('\n=== cat /m/config.json ===')
  console.log(await out('cat /m/config.json'))

  console.log('=== wc -l /m/config.json ===')
  console.log(`  ${(await out('wc -l /m/config.json')).trim()}`)

  // ── jq: introspect the architecture ─────────────────
  console.log('\n=== jq .model_type /m/config.json ===')
  console.log(`  ${(await out('jq .model_type /m/config.json')).trim()}`)

  console.log('=== jq .architectures /m/config.json ===')
  console.log(`  ${(await out('jq .architectures /m/config.json')).trim()}`)

  console.log(
    "=== jq '{hidden_size, num_hidden_layers, num_attention_heads, vocab_size}' /m/config.json ===",
  )
  console.log(
    await out("jq '{hidden_size, num_hidden_layers, num_attention_heads, vocab_size}' /m/config.json"),
  )

  // ── tokenizer config ────────────────────────────────
  console.log('=== cat /m/tokenizer_config.json | jq .pad_token_id ===')
  console.log(
    `  ${(await out("cat /m/tokenizer_config.json | jq .pad_token_id 2>/dev/null || echo '(no pad_token_id)'")).trim()}`,
  )

  // ── README inspection ───────────────────────────────
  console.log('\n=== head -n 30 /m/README.md ===')
  console.log(await out('head -n 30 /m/README.md'))

  console.log('=== grep -ic license /m/README.md ===')
  console.log(`  matches: ${(await out('grep -ic license /m/README.md')).trim()}`)

  // ── sed: read-transform on the read-only HF mount ───
  console.log("\n=== sed -n '1,3p' /m/config.json (print first 3 lines) ===")
  console.log(await out("sed -n '1,3p' /m/config.json"))

  console.log('=== cat /m/config.json | sed \'s/"//g\' | head -n 3 (strip quotes) ===')
  console.log(await out('cat /m/config.json | sed \'s/"//g\' | head -n 3'))

  // ── find variants ───────────────────────────────────
  console.log("\n=== find /m/ -name '*.json' ===")
  console.log(await out("find /m/ -name '*.json'"))

  console.log("=== find /m/ -name '*.safetensors' ===")
  console.log(await out("find /m/ -name '*.safetensors'"))

  console.log('=== find /m/ -type f -size +1M ===')
  console.log(await out('find /m/ -type f -size +1M'))

  // ── pipelines ───────────────────────────────────────
  console.log("=== find /m/ -name '*.json' | sort | head ===")
  console.log(await out("find /m/ -name '*.json' | sort | head"))

  console.log("=== cat /m/config.json | grep -c ':' ===")
  console.log(`  config keys: ${(await out("cat /m/config.json | grep -c ':'")).trim()}`)

  // ── barriers ────────────────────────────────────────
  console.log('\n=== test for safetensors via grep -q ===')
  console.log(
    `  ${(await out("ls /m/ | grep -q safetensors && echo 'has weights' || echo 'no weights'")).trim()}`,
  )

  // ── quoting + command substitution ──────────────────
  console.log('\n=== quoting + $(...) ===')
  await ws.shell('export CFG=/m/config.json')
  console.log(`  jq .hidden_size "$CFG": ${(await out('jq .hidden_size "$CFG"')).trim()}`)
  console.log(`  via $(): ${(await out('cat $(echo /m/config.json) | jq .num_hidden_layers')).trim()}`)

  // ── background jobs ─────────────────────────────────
  console.log('\n=== background: jq fields in parallel ===')
  console.log(
    `  stdout: ${(await out('jq .hidden_size /m/config.json & jq .num_hidden_layers /m/config.json & jq .vocab_size /m/config.json & wait; echo done')).trim()}`,
  )

  // ── byte-range read of the safetensors header ───────
  console.log('\n=== STREAMING (range reads on 2GB weights) ===')

  await ws.cache.clear()
  await measure(
    'head -c 128 model.safetensors (range)',
    'head -c 128 /m/model.safetensors | xxd | head -n 4',
  )
  await ws.cache.clear()
  await measure("stat -c '%s' model.safetensors", "stat -c '%s' /m/model.safetensors")
  await ws.cache.clear()
  await measure('cat config.json | jq .vocab_size', 'cat /m/config.json | jq .vocab_size')
  await ws.cache.clear()
  await measure('wc -c config.json', 'wc -c /m/config.json')

  console.log(`\nFinal: ${opsSummary()}`)
  console.log('(2GB safetensors never fully downloaded; only header range + configs read)')
}

main()
  .catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => ws.close())
