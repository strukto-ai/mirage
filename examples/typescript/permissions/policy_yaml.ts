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

import {
  Workspace,
  configToWorkspaceArgs,
  loadWorkspaceConfigFile,
  type MountSpec,
} from '@struktoai/mirage-node'

// The reviewer's policy as a document. workspace.yaml names the program
// (guard.py, beside it) and the engine that runs it; the config door
// reads the file, embeds the program's source, and hands back what
// `new Workspace` takes, which is what `mirage workspace create` does
// behind the daemon. A path in the document is relative to the
// document, never to the process. The document is written once and read
// by both implementations, so this file loads the python example's. The
// in-code spelling of the same block is policy.ts.

const CONFIG = new URL('../../python/permissions/workspace.yaml', import.meta.url).pathname

const SEED = [
  'mkdir -p /scratch/cold && echo keep > /scratch/cold/k',
  'echo marker > /repo/flagged.txt',
  'echo hello > /repo/notes.txt',
]

// "host" runs the line with no session, which is the workspace's own
// unrestricted view: no profile, so no program.
const LINES: [string, string, string][] = [
  ['reviewer', 'cat /repo/notes.txt', 'pre_command read the file and found no marker'],
  ['reviewer', 'cat /repo/flagged.txt', 'and refuses one that holds it'],
  ['reviewer', 'echo x > /scratch/cold/f', 'pre_ops refuses a write at the op door'],
  ['reviewer', 'export AWS_SECRET=x', 'pre_session refuses a credential'],
  ['reviewer', 'export SAFE=1 && echo $SAFE', 'silence where no hook objects'],
  ['host', 'cat /repo/flagged.txt', 'no profile, so no program'],
  ['host', 'export AWS_SECRET=x', "the program is the profile's, not the workspace's"],
]

const dec = new TextDecoder()

/** One line's outcome: what came back, or why nothing did. */
function answer(out: string, err: string, code: number): string {
  if (err !== '') return `[${code}] ${err.split('\n')[0]}`
  return `[${code}] ${out.split(/\s+/).filter(Boolean).join(' ')}`.trimEnd()
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

async function main(): Promise<void> {
  const args = await configToWorkspaceArgs(loadWorkspaceConfigFile(CONFIG))
  const resources: Record<string, MountSpec> = {}
  for (const [prefix, [resource, mode]] of Object.entries(args.resources)) {
    resources[prefix] = [resource, mode]
  }
  const ws = new Workspace(resources, args.options)
  try {
    for (const line of SEED) await ws.execute(line)
    ws.createSession('reviewer', { profile: 'reviewer' })

    for (const [who, line, note] of LINES) {
      const res = await (who === 'host' ? ws.execute(line) : ws.execute(line, { sessionId: who }))
      const out = res.stdout === null ? '' : dec.decode(res.stdout)
      const err = res.stderr === null ? '' : dec.decode(res.stderr)
      console.log(`${pad(who, 9)} ${pad(line, 30)} ${answer(out, err, res.exitCode)}`)
      console.log(`${pad('', 9)} ${pad('', 30)} ${note}`)
    }
  } finally {
    await ws.close()
  }
}

await main()
