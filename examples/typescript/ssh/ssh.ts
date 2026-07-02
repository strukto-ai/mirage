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

import { homedir } from 'node:os'
import { MountMode, SSHResource, type FileStat, type SSHConfig, Workspace } from '@struktoai/mirage-node'

const config: SSHConfig = {
  host: 'dev',
  hostname: 'ec2-18-216-110-204.us-east-2.compute.amazonaws.com',
  username: 'ubuntu',
  identityFile: `${homedir()}/.ssh/dev.pem`,
  root: '/home/ubuntu/mirage-test',
}

const resource = new SSHResource(config)

async function main(): Promise<void> {
  const ws = new Workspace({ '/ssh/': resource }, { mode: MountMode.WRITE })

  const show = async (label: string, cmd: string): Promise<void> => {
    console.log(`=== ${label} ===`)
    const r = await ws.execute(cmd)
    console.log(r.stdoutText)
  }

  try {
    await show('ls /ssh/', 'ls /ssh/')
    await show('stat /ssh/', 'stat /ssh/')
    await show('tree /ssh/', 'tree /ssh/')
    await show('find /ssh/', 'find /ssh/')
    await show('du /ssh/', 'du /ssh/')
    await show('cat /ssh/readme.txt', 'cat /ssh/readme.txt')
    await show('head -n 1 /ssh/data.txt', 'head -n 1 /ssh/data.txt')
    await show('wc /ssh/readme.txt', 'wc /ssh/readme.txt')
    await show('grep hello /ssh/readme.txt', 'grep hello /ssh/readme.txt')


    // chmod/chown/touch never hit the SFTP server: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /ssh/readme.txt ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/ssh/readme.txt" && chown 500:dev "/ssh/readme.txt" && touch -t 202601021530 "/ssh/readme.txt"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/ssh/readme.txt`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    // ── generic text commands (delegate to shared generics) ──
    const generics = [
      'sort /ssh/data.txt',
      'sort -r /ssh/data.txt',
      'nl /ssh/data.txt',
      'rev /ssh/data.txt',
      'tac /ssh/data.txt',
      'cut -c1-4 /ssh/data.txt',
      'uniq /ssh/data.txt',
      'fold -w 3 /ssh/data.txt',
      'head -n 2 /ssh/data.txt',
      'tail -n 1 /ssh/data.txt',
      'wc -l /ssh/data.txt',
      'sha256sum /ssh/data.txt',
    ]
    for (const cmd of generics) await show(cmd, cmd)

    await ws.execute('cd /ssh/')
    await show('cd /ssh/ && ls', 'ls')
    await show('pwd', 'pwd')

    await ws.execute('cd /ssh/docs')
    await show('cd /ssh/docs && cat guide.txt', 'cat guide.txt')
    await ws.execute('cd ..')
    await show('cd .. && ls', 'ls')

    await ws.execute('echo hello > /ssh/test.txt')
    await show('cat /ssh/test.txt', 'cat /ssh/test.txt')

    await ws.execute('cp /ssh/test.txt /ssh/test2.txt')
    await show('cp /ssh/test.txt /ssh/test2.txt', 'ls /ssh/')

    await ws.execute('mv /ssh/test2.txt /ssh/renamed.txt')
    await show('mv /ssh/test2.txt /ssh/renamed.txt', 'ls /ssh/')

    await ws.execute('mkdir /ssh/subdir')
    await ws.execute('echo world > /ssh/subdir/nested.txt')
    await show('tree /ssh/', 'tree /ssh/')

    await ws.execute('rm /ssh/renamed.txt')
    await ws.execute('rm -r /ssh/subdir')
    await ws.execute('rm /ssh/test.txt')
    await show('final ls /ssh/', 'ls /ssh/')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
