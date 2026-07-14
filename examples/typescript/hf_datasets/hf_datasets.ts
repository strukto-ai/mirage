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
// No credentials required. Set HF_DATASET_REPO / HF_TOKEN for private repos.
import {
  HfDatasetsResource,
  Workspace,
  MountMode,
  type FileStat,
  type HfDatasetsConfig,
} from '@struktoai/mirage-node'

function configFromEnv(): HfDatasetsConfig {
  return {
    repoId: process.env.HF_DATASET_REPO ?? 'AlienKevin/SWE-ZERO-12M-trajectories',
    ...(process.env.HF_TOKEN !== undefined ? { token: process.env.HF_TOKEN } : {}),
  }
}

async function run(ws: Workspace, cmd: string): Promise<void> {
  console.log(`=== ${cmd} ===`)
  process.stdout.write((await ws.execute(cmd)).stdoutText)
  console.log()
}

async function main(): Promise<void> {
  const resource = new HfDatasetsResource(configFromEnv())
  const ws = new Workspace({ '/ds/': resource }, { mode: MountMode.READ })
  console.log(`=== mounted ${resource.accessor.bucketUri} at /ds/ ===\n`)

  try {
    await run(ws, 'ls /ds/')
    await run(ws, 'ls -lh /ds/')
    await run(ws, 'stat /ds/README.md')


    // chmod/chown/touch never hit the Hub API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /ds/README.md ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/ds/README.md" && chown 500:dev "/ds/README.md" && touch -t 202601021530 "/ds/README.md"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/ds/README.md`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )
    await run(ws, "find /ds/ -name '*.md'")
    await run(ws, 'find /ds/ -type d')
    await run(ws, "find /ds/ -name '*.parquet' | head -n 5")
    await run(ws, "find /ds/ -name '*.parquet' | wc -l")
    await run(ws, 'cat /ds/README.md | head -n 20')
    await run(ws, 'wc -l /ds/README.md')
    await run(ws, 'head -c 200 /ds/README.md')
    await run(ws, 'grep -c parquet /ds/README.md')
    await run(ws, "find /ds/ -name '*.parquet' | sort | head -n 3")
    await run(ws, "grep -q parquet /ds/README.md && echo 'found'")
    await run(ws, "grep -q nope /ds/README.md || echo 'absent'")
    await run(ws, 'export TGT=/ds/README.md; cat "$TGT" | head -n 2')
    await run(ws, 'head -n 1 $(echo /ds/README.md)')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
