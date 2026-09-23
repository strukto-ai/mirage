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

import { DevVFS, MountMode, Workspace } from '@struktoai/mirage-node'

async function main(): Promise<void> {
  const dev = new DevVFS()
  const ws = new Workspace({ '/dev': dev }, { mode: MountMode.WRITE })

  console.log('=== ls /dev/ ===')
  const lsRes = await ws.shell('ls /dev/')
  process.stdout.write(lsRes.stdoutText + '\n')

  console.log('=== stat /dev/null ===')
  const statNull = await ws.shell('stat /dev/null')
  process.stdout.write(statNull.stdoutText + '\n')

  console.log('=== stat /dev/zero ===')
  const statZero = await ws.shell('stat /dev/zero')
  process.stdout.write(statZero.stdoutText + '\n')

  console.log('=== wc -c /dev/null (should be 0) ===')
  const wcNull = await ws.shell('wc -c /dev/null')
  process.stdout.write(wcNull.stdoutText + '\n')

  console.log('=== bounded read from /dev/zero (should be 2097152) ===')
  const wcZero = await ws.shell('head -c 2M /dev/zero | wc -c')
  process.stdout.write(wcZero.stdoutText + '\n')

  console.log('=== /dev/null device metadata ===')
  const statDevice = await ws.shell("stat -c '%F %t %T' /dev/null")
  process.stdout.write(statDevice.stdoutText + '\n')

  console.log('=== write to /dev/null is silently dropped ===')
  await ws.shell('echo "this disappears" | tee /dev/null')
  const after = await ws.shell('wc -c /dev/null')
  process.stdout.write(`after write: ${after.stdoutText}\n`)

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
