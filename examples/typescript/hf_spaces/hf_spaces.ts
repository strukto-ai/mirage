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
import { HfSpacesResource, Workspace, MountMode, type FileStat, type HfSpacesConfig } from '@struktoai/mirage-node'

function configFromEnv(): HfSpacesConfig {
  return {
    repoId: process.env.HF_SPACE_REPO ?? 'HuggingFaceBio/carbon-demo',
    ...(process.env.HF_TOKEN !== undefined ? { token: process.env.HF_TOKEN } : {}),
  }
}

async function run(ws: Workspace, cmd: string): Promise<void> {
  console.log(`=== ${cmd} ===`)
  process.stdout.write((await ws.execute(cmd)).stdoutText)
  console.log()
}

async function main(): Promise<void> {
  const resource = new HfSpacesResource(configFromEnv())
  const ws = new Workspace({ '/s/': resource }, { mode: MountMode.READ })
  console.log(`=== mounted ${resource.accessor.bucketUri} at /s/ ===\n`)

  try {
    await run(ws, 'ls /s/')
    await run(ws, 'tree -L 2 /s/')
    await run(ws, 'stat /s/README.md')


    // chmod/chown/touch never hit the Hub API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /s/README.md ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/s/README.md" && chown 500:dev "/s/README.md" && touch -t 202601021530 "/s/README.md"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/s/README.md`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )
    await run(ws, 'find /s/ -type d')
    await run(ws, "find /s/ -name '*.py'")
    await run(ws, 'find /s/ -maxdepth 1 -type f')
    await run(ws, 'cat /s/README.md | head -n 15')
    await run(ws, 'wc -l /s/README.md')
    await run(ws, "cat /s/requirements.txt 2>/dev/null || echo '(no requirements.txt)'")
    await run(ws, "grep -c '^import\\|^from' /s/app.py 2>/dev/null || echo 0")
    await run(ws, "find /s/ -name '*.py' | sort | head -n 5")
    await run(ws, "cat /s/README.md | grep -i '^#' | head -n 10")
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
