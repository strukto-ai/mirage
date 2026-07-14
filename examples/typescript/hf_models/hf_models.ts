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
import { HfModelsResource, Workspace, MountMode, type FileStat, type HfModelsConfig } from '@struktoai/mirage-node'

function configFromEnv(): HfModelsConfig {
  return {
    repoId: process.env.HF_MODEL_REPO ?? 'sapientinc/HRM-Text-1B',
    ...(process.env.HF_TOKEN !== undefined ? { token: process.env.HF_TOKEN } : {}),
  }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const resource = new HfModelsResource(config)
  const ws = new Workspace({ '/m/': resource }, { mode: MountMode.READ })
  console.log(`=== mounted ${resource.accessor.bucketUri} at /m/ ===\n`)

  try {
    console.log('=== ls /m/ ===')
    process.stdout.write((await ws.execute('ls /m/')).stdoutText)
    console.log()

    console.log('=== tree /m/ ===')
    process.stdout.write((await ws.execute('tree /m/')).stdoutText)
    console.log()

    console.log('=== stat /m/config.json ===')
    process.stdout.write((await ws.execute('stat /m/config.json')).stdoutText)


    // chmod/chown/touch never hit the Hub API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /m/config.json ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/m/config.json" && chown 500:dev "/m/config.json" && touch -t 202601021530 "/m/config.json"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/m/config.json`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )
    console.log()

    console.log("=== stat -c '%s' /m/model.safetensors (no download) ===")
    process.stdout.write((await ws.execute("stat -c '%s' /m/model.safetensors")).stdoutText)
    console.log()

    console.log('=== cat /m/config.json ===')
    process.stdout.write((await ws.execute('cat /m/config.json')).stdoutText)
    console.log()

    console.log('=== jq .architectures /m/config.json ===')
    process.stdout.write((await ws.execute('jq .architectures /m/config.json')).stdoutText)
    console.log()

    // sed read-transform over the HF mount
    console.log("=== sed -n '1,3p' /m/config.json ===")
    process.stdout.write((await ws.execute("sed -n '1,3p' /m/config.json")).stdoutText)
    console.log("=== cat /m/config.json | sed 's/\"//g' | head -n 3 ===")
    process.stdout.write(
      (await ws.execute('cat /m/config.json | sed \'s/"//g\' | head -n 3')).stdoutText,
    )
    console.log()

    console.log('=== head -n 10 /m/README.md ===')
    process.stdout.write((await ws.execute('head -n 10 /m/README.md')).stdoutText)
    console.log()

    console.log("=== find /m/ -name '*.json' | sort ===")
    process.stdout.write((await ws.execute("find /m/ -name '*.json' | sort")).stdoutText)
    console.log()

    console.log('=== wc -l /m/config.json ===')
    process.stdout.write((await ws.execute('wc -l /m/config.json')).stdoutText)
    console.log()

    console.log("=== grep -c ':' /m/config.json ===")
    process.stdout.write((await ws.execute("grep -c ':' /m/config.json")).stdoutText)
    console.log()
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
