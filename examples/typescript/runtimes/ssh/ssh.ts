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
import {
  MountMode,
  S3VFS,
  SSHVFS,
  SSHRuntime,
  Workspace,
  type S3Config,
  type SSHConfig,
} from '@struktoai/mirage-node'

// The dataset lives in S3; the compute lives on a machine you can
// already ssh into. The workspace holds both: the bucket at /data and
// the box's own directory at a prefix EQUAL to its remote absolute
// path, so a captured python3 line and the workspace spell that
// directory's files identically (the "Skip the FUSE" recipe). The box
// cannot see /data (mirage mounts live only in the workspace), so the
// data is STAGED: one cp reads S3 and writes over SFTP, and from then
// on the remote interpreter opens a plain local file.
//
// Unlike asyncssh, ssh2 does not read ~/.ssh/config, so the alias is
// spelled out: hostname, username and identityFile ride the config.

const REMOTE_DIR = '/home/ubuntu/mirage'
const HOSTNAME = 'ec2-18-216-110-204.us-east-2.compute.amazonaws.com'
const IDENTITY = `${homedir()}/.ssh/dev.pem`

const dataConfig: S3Config = {
  bucket: process.env.AWS_S3_BUCKET ?? '',
  region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  keyPrefix: 'ssh-runtime-demo/',
}

const projConfig: SSHConfig = {
  host: 'dev',
  hostname: HOSTNAME,
  username: 'ubuntu',
  identityFile: IDENTITY,
  root: REMOTE_DIR,
}

const LOAD_PY = [
  'import csv, json, sys',
  'rows = list(csv.DictReader(open(sys.argv[1])))',
  'total = sum(float(r["value"]) for r in rows)',
  'out = {"rows": len(rows), "total": total}',
  'json.dump(out, open("result.json", "w"))',
  'print("loaded", len(rows), "rows; total", total)',
  '',
].join('\n')

const POINTS_CSV = 'name,value\nalpha,1.5\nbeta,2.5\ngamma,4.0\n'

const ENC = new TextEncoder()

async function show(ws: Workspace, command: string): Promise<void> {
  const result = await ws.shell(command, { cwd: REMOTE_DIR })
  console.log(`$ ${command}`)
  if (result.stdoutText) {
    process.stdout.write(result.stdoutText.endsWith('\n') ? result.stdoutText : `${result.stdoutText}\n`)
  }
  if (result.exitCode !== 0) {
    console.log(`  exit ${result.exitCode}: ${result.stderrText.trim()}`)
  }
}

async function main(): Promise<void> {
  const runtime = new SSHRuntime({
    captures: ['python3'],
    config: { host: 'dev', hostname: HOSTNAME, username: 'ubuntu', identityFile: IDENTITY },
  })
  const ws = new Workspace(
    { '/data': new S3VFS(dataConfig), [REMOTE_DIR]: new SSHVFS(projConfig) },
    { mode: MountMode.EXEC, runtimes: [runtime, 'workspace'] },
  )

  try {
    // Seed both sides through the workspace: the dataset into S3, the
    // loader onto the box (an SFTP write; the box provisions itself).
    await ws.shell('cat > /data/points.csv', { stdin: ENC.encode(POINTS_CSV) })
    await ws.shell(`cat > ${REMOTE_DIR}/load.py`, { stdin: ENC.encode(LOAD_PY) })
    await show(ws, 'ls /data')
    await show(ws, 'ls')

    // The boundary, demonstrated: the captured line runs on the box,
    // whose kernel has never heard of the workspace's S3 mount.
    await show(ws, 'python3 load.py /data/points.csv')

    // Stage: mirage reads the S3 side and writes the SFTP side.
    await show(ws, 'cp /data/points.csv points.csv')

    // Now the operand is a real file beside load.py on the box.
    await show(ws, 'python3 load.py points.csv')

    // The result the remote interpreter wrote is already visible
    // through the mount, one path spelling on both sides.
    await show(ws, 'cat result.json')

    await show(ws, 'rm load.py points.csv result.json /data/points.csv')
  } finally {
    await runtime.close()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
