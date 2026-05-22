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

async function main(): Promise<void> {
  const ram = new RAMResource()
  const ws = new Workspace({ '/ram': ram }, { mode: MountMode.EXEC })

  console.log('python3 reads a script file from ANY mount — demo: /ram/\n')
  console.log('Script path is dispatched through the workspace mount registry,')
  console.log('so /ram/, /disk/, /s3/, /redis/ — all work the same way.\n')

  // ── 1. Seed a Python script into the RAM mount via shell heredoc ──
  console.log('=== 1. seed /ram/python.py via heredoc ===')
  await ws.execute(
    `cat > /ram/python.py <<'PYEOF'
import sys

name = sys.argv[1] if len(sys.argv) > 1 else 'world'
print(f'hello, {name}!')
print(f'args: {sys.argv[1:]}')
print(f'sum(1..10): {sum(range(1, 11))}')
PYEOF`,
  )
  const ls = await ws.execute('ls /ram/')
  process.stdout.write(ls.stdoutText)
  console.log()

  // ── 2. Run it with no args ──
  console.log('=== 2. python3 /ram/python.py (no args) ===')
  const r1 = await ws.execute('python3 /ram/python.py')
  process.stdout.write(r1.stdoutText)
  console.log(`exit: ${String(r1.exitCode)}\n`)

  // ── 3. Run it with positional args → sys.argv ──
  console.log('=== 3. python3 /ram/python.py alice bob ===')
  const r2 = await ws.execute('python3 /ram/python.py alice bob')
  process.stdout.write(r2.stdoutText)
  console.log(`exit: ${String(r2.exitCode)}\n`)

  // ── 4. Seed a second script that reads data from RAM ──
  console.log('=== 4. seed /ram/data.jsonl + /ram/count.py ===')
  await ws.execute(
    `cat > /ram/data.jsonl <<'EOF'
{"user": "alice", "action": "login"}
{"user": "bob", "action": "click"}
{"user": "alice", "action": "logout"}
EOF`,
  )
  // Note: Pyodide has its own virtual FS — it does NOT have /ram/.
  // To feed file contents in, we pipe from the shell (cat ... | python3 script.py).
  await ws.execute(
    `cat > /ram/count.py <<'PYEOF'
import sys, json
from collections import Counter

counts = Counter()
for line in sys.stdin:
    rec = json.loads(line)
    counts[rec['user']] += 1
for user, n in counts.most_common():
    print(f'{user}: {n}')
PYEOF`,
  )

  console.log('=== 5. cat /ram/data.jsonl | python3 /ram/count.py ===')
  const r3 = await ws.execute('cat /ram/data.jsonl | python3 /ram/count.py')
  process.stdout.write(r3.stdoutText)
  console.log(`exit: ${String(r3.exitCode)}\n`)

  // ── 6. Edit the script in place and re-run — proves mount is the source of truth ──
  console.log('=== 6. overwrite /ram/python.py and re-run ===')
  await ws.execute(
    `cat > /ram/python.py <<'PYEOF'
print('script was replaced!')
PYEOF`,
  )
  const r4 = await ws.execute('python3 /ram/python.py')
  process.stdout.write(r4.stdoutText)
  console.log(`exit: ${String(r4.exitCode)}\n`)

  // ── 7. Missing script → graceful error ──
  console.log('=== 7. python3 /ram/missing.py → "No such file", exit 1 ===')
  const r5 = await ws.execute('python3 /ram/missing.py')
  console.error('stderr:', r5.stderrText.trim())
  console.log(`exit: ${String(r5.exitCode)}\n`)

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
