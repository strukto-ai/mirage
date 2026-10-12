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
  MountMode,
  RAMVFS,
  ScriptSource,
  Workspace,
  parseSessionProfile,
  type Deny,
  type Policy,
  type SessionContext,
} from '@struktoai/mirage-node'

// A release workspace under two policies, one through each entry point code
// has, and the point of the example is what each entry point is for:
//
//   a coded Policy     an object passed as `policies: [...]`. It runs in
//                      this process, needs no engine, may define any of
//                      the eight methods, and speaks for every session: the
//                      operator's own rule.
//   a profile policy   programs passed as a profile's `policy` block, a
//                      list per pre_ method, each with the runtime that
//                      runs it. They run sandboxed on that runtime, read
//                      the same ctx as JSON, print their answer, and speak
//                      only for the sessions under that profile.
//
// The same block spelled as a document is policy_yaml.ts, beside this
// file.

/** Refuse an env write that would set a credential, for everyone. */
const operatorOwnsCredentials: Policy = {
  preSession(ctx: SessionContext): Deny | null {
    return ctx.key.startsWith('AWS_')
      ? { kind: 'deny', reason: 'credentials are set by the operator' }
      : null
  },
}

// The reviewer's programs: python source, run on monty, one for each
// method it has an opinion at. Each reads its context as JSON, the same
// fields a coded policy reads, and prints its answer: nothing for no
// opinion, {"kind": "deny", "reason": ...} to refuse. `open()` reads
// through the workspace as the session, so the command program can judge
// what a file holds, not only what it is called.
const MARKED = new ScriptSource(`
import json
import os

ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])

def contents(path):
    try:
        return open(path).read()
    except OSError:
        return ""

if any("marker" in contents(path) for path in ctx["paths"]):
    reason = "marked files are not read by " + ctx["profile"]
    print(json.dumps({"kind": "deny", "reason": reason}))
`)

const COLD = new ScriptSource(`
import json
import os

ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])
if ctx["write"] and ctx["path"].startswith("/scratch/cold/"):
    print(json.dumps({"kind": "deny", "reason": "the cold store is frozen"}))
`)

const SEED = [
  'mkdir -p /scratch/cold && echo keep > /scratch/cold/k',
  'echo marker > /repo/flagged.txt',
  'echo hello > /repo/notes.txt',
]

// "host" runs the line with no session, which is the workspace's own
// unrestricted view: no profile, so no program, but every coded policy.
const LINES: [string, string, string][] = [
  ['reviewer', 'cat /repo/notes.txt', 'pre_command read the file and found no marker'],
  ['reviewer', 'cat /repo/flagged.txt', 'and refuses one that holds it; the reason is for the operator'],
  ['reviewer', 'export AWS_SECRET=x', 'the coded policy, at the session view'],
  ['reviewer', 'export SAFE=1 && echo $SAFE', 'silence where no method objects'],
  ['host', 'cat /repo/flagged.txt', 'no profile, so no program'],
  ['host', 'export AWS_SECRET=x', 'the coded policy speaks for every session'],
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
  const ws = new Workspace(
    { '/repo/': new RAMVFS(), '/scratch/': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      policies: [operatorOwnsCredentials],
      // The workspace takes parsed profiles; the document is validated
      // here rather than in the constructor, as in permissions.ts.
      profiles: {
        reviewer: parseSessionProfile(
          {
            policy: {
              pre_command: [{ script: MARKED, runtime: 'monty' }],
              pre_vfs: [{ script: COLD, runtime: 'monty' }],
            },
          },
          'profile `reviewer`',
        ),
      },
    },
  )
  try {
    for (const line of SEED) await ws.shell(line)
    ws.createSession('reviewer', { profile: 'reviewer' })

    for (const [who, line, note] of LINES) {
      const res = await (who === 'host' ? ws.shell(line) : ws.shell(line, { sessionId: who }))
      const out = res.stdout === null ? '' : dec.decode(res.stdout)
      const err = res.stderr === null ? '' : dec.decode(res.stderr)
      console.log(`${pad(who, 9)} ${pad(line, 30)} ${answer(out, err, res.exitCode)}`)
      console.log(`${pad('', 9)} ${pad('', 30)} ${note}`)
    }

    // A dry run names who would speak, through the session's own entry points:
    // a line, as the tree of its commands, and one VFS call of an entry point that
    // sees no command (a file tool, FUSE).
    const explain = (await ws.session('reviewer')).explain
    const shellRes = await explain.shell('cat /repo/flagged.txt')
    for (const cmd of shellRes.node.children) {
      if (!('command' in cmd)) continue
      for (const a of cmd.answers) {
        console.log(`${pad('explain', 9)} ${pad('cat /repo/flagged.txt', 30)} ${a.policy ?? ''}: ${a.reason}`)
      }
    }
    const vfsRes = await explain.vfs.write('/scratch/cold/f', 'draft')
    for (const a of vfsRes.answers) {
      console.log(`${pad('explain', 9)} ${pad('write /scratch/cold/f', 30)} ${a.policy ?? ''}: ${a.reason}`)
    }
  } finally {
    await ws.close()
  }
}

await main()
