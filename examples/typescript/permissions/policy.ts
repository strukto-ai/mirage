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
  RAMResource,
  ScriptSource,
  Workspace,
  parseSessionProfile,
  type Deny,
  type Policy,
  type SessionContext,
} from '@struktoai/mirage-node'

// A release workspace under two policies, one through each door code
// has, and the point of the example is what each door is for:
//
//   a coded Policy     an object passed as `policies: [...]`. It runs in
//                      this process, needs no engine, may define any of
//                      the five hooks, and speaks for every session: the
//                      operator's own rule.
//   a profile policy   a program passed as a profile's `policy` block,
//                      source plus the engine that runs it. It runs
//                      sandboxed on that engine, defines any of the
//                      three admission hooks, and speaks only for the
//                      sessions under that profile.
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

// The reviewer's program: python source, run on monty. It defines the
// two hooks it has an opinion at and stays silent at the third. A hook
// answers with return: None for no opinion, {"deny": reason} to refuse.
// `open()` reads through the workspace, so the command gate can judge
// what a file holds, not only what it is called.
const REVIEWER = new ScriptSource(`
def pre_command(ctx):
    for path in ctx["command"]["paths"]:
        if "marker" in contents(path):
            return {"deny": "marked files are not read by " + ctx["profile"]}
    return None

def pre_ops(ctx):
    op = ctx["op"]
    if op["write"] and op["path"].startswith("/scratch/cold/"):
        return {"deny": "the cold store is frozen"}
    return None

def contents(path):
    try:
        return open(path).read()
    except OSError:
        return ""
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
  ['reviewer', 'cat /scratch/cold/k', 'pre_ops lets a read through'],
  ['reviewer', 'echo x > /scratch/cold/f', 'and refuses a write at the op door'],
  ['reviewer', 'rm /scratch/cold/k', 'whichever command asked for it'],
  ['reviewer', 'export AWS_SECRET=x', 'the coded policy, at the session door'],
  ['reviewer', 'export SAFE=1 && echo $SAFE', 'silence where no hook objects'],
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
    { '/repo/': new RAMResource(), '/scratch/': new RAMResource() },
    {
      mode: MountMode.WRITE,
      policies: [operatorOwnsCredentials],
      // The workspace takes parsed profiles; the document is validated
      // here rather than in the constructor, as in permissions.ts.
      profiles: {
        reviewer: parseSessionProfile(
          { policy: { script: REVIEWER, runtime: 'monty' } },
          'profile `reviewer`',
        ),
      },
    },
  )
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
