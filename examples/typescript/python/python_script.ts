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

import { MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'

const SCRIPT = `
import json, sys

records = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    records.append(json.loads(line))

# summary stats
print(f"count: {len(records)}")
print(f"keys:  {sorted({k for r in records for k in r})}")
for r in records[:3]:
    print(f"  - {json.dumps(r)}")
`

async function main(): Promise<void> {
  const disk = new RAMResource()
  const ws = new Workspace({ '/disk': disk }, { mode: MountMode.EXEC })

  console.log('python3 script file (read from mount) + piped stdin\n')

  // Seed a JSONL corpus into the disk mount
  await ws.execute(
    `cat > /disk/data.jsonl <<'EOF'
{"type":"login","user":"alice","ts":1}
{"type":"click","user":"alice","ts":2}
{"type":"login","user":"bob","ts":3}
{"type":"logout","user":"alice","ts":4}
EOF`,
  )

  // Write the script to the disk mount
  await ws.execute('mkdir -p /disk/scripts')
  const write = await ws.execute(`cat > /disk/scripts/summarize.py <<'PYEOF'\n${SCRIPT}\nPYEOF`)
  if (write.exitCode !== 0) {
    console.error('failed to seed script:', write.stderrText)
    process.exit(1)
  }

  console.log('=== python3 /disk/scripts/summarize.py < stdin (from pipe) ===')
  const res = await ws.execute('cat /disk/data.jsonl | python3 /disk/scripts/summarize.py')
  process.stdout.write(res.stdoutText)
  if (res.stderr.length > 0) {
    console.error('STDERR:', res.stderrText)
  }
  console.log(`exit: ${String(res.exitCode)}\n`)

  console.log('=== same pipeline with inline -c (one-line style) ===')
  const pipeline = await ws.execute(
    `head -n 2 /disk/data.jsonl | python3 -c "import sys, json; [print(json.loads(l)['user'], '->', json.loads(l)['type']) for l in sys.stdin]"`,
  )
  process.stdout.write(pipeline.stdoutText)
  if (pipeline.stderr.length > 0) {
    console.error('STDERR:', pipeline.stderrText)
  }
  console.log(`exit: ${String(pipeline.exitCode)}\n`)

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
