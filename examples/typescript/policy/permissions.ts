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

import { MountMode, RAMVFS, Workspace, SessionProfile } from '@struktoai/mirage-node'

// An incident-response workspace: the service tree, the runbooks the
// oncall works from, and the credentials nobody reads by hand.
//
// Three roles read the same three mounts and see three different
// filesystems. A role's command tree is read in three steps, and every
// refusal below comes from one of them:
//
//   the name     the tree maps command names to decisions. The root `*`
//                is every command it does not name, so a root deny
//                leaves a role only the commands the tree names.
//   the paths    a decision that lists paths speaks only for those
//                paths. A list holds several decisions for one command,
//                and the strictest that covers a path wins: deny, then
//                ask, then allow.
//   the mount    a mount section's tree is judged beside the role's own
//                for a line that works inside the mount, and the
//                stricter answer wins, so it only tightens.
//
// Hiding is none of these: it is not a refusal at all. A hidden path
// answers ENOENT, so the role never learns the name; a denied path stays
// in the listing and fails when read. /vault is denied for the oncall
// and hidden for the auditor, which is the same three files seen two
// ways.
//
// The third role, the commander, states no root deny, which is how a
// role says "every tool": a command the tree does not decide is allowed.
// Its one decision still runs.

const VAULT = {
  decision: 'deny',
  reason: 'credentials are never read by hand',
  paths: ['/vault/*'],
}
const NOD = {
  decision: 'ask',
  reason: 'a runbook edit needs a nod',
  paths: ['/runbook/*'],
}

const PROFILES = {
  oncall: {
    commands: {
      // Every command the tree does not name is refused:
      // `sort: Permission denied`.
      '*': 'deny',
      ls: 'allow',
      // A named command answers for itself, so each one that could read
      // a credential carries the deny.
      cat: ['allow', VAULT],
      grep: ['allow', VAULT],
      rm: ['allow', NOD],
      cp: ['allow', NOD, VAULT],
    },
    mounts: {
      '/repo': {
        // Modes only ever narrow: the workspace mounts /repo write, and
        // this role reads it.
        mode: 'read',
        // A name pattern written in a mount section is anchored to that
        // mount when the role compiles, so this is every .env under
        // /repo and nothing anywhere else.
        paths: { hide: ['*.env'] },
      },
      '/runbook': {
        // This tree is asked about a line that works inside /runbook,
        // beside the role's own. For a frozen file the role's tree asks
        // and this one denies, and the stricter answer wins.
        commands: {
          rm: {
            decision: 'deny',
            reason: 'the rollback plan is frozen',
            paths: ['/runbook/frozen/*'],
          },
        },
      },
    },
  },
  auditor: {
    // No rm, no cp: this role cannot be talked into a write, because
    // its tree names neither.
    commands: { '*': 'deny', ls: 'allow', cat: 'allow', grep: 'allow' },
    // Hidden, where the oncall has it denied. Same mount, same files,
    // two different answers to `ls /vault`.
    paths: { hide: ['/vault'] },
  },
  commander: {
    commands: {
      // No root deny, so every command mirage ships runs, this role's
      // own `sort` and `wc` included. What that does not say is
      // "unrestricted": the root `*` here decides for /vault alone, and
      // denies any command that names a path there.
      '*': VAULT,
    },
    // No mount section either, so every mount stays at the mode the
    // workspace declared. A role narrows by naming; naming nothing
    // narrows nothing.
  },
}

const SEED = [
  'mkdir -p /runbook/frozen',
  'echo "print(\'serving\')" > /repo/service.py',
  'echo DSN=postgres://localhost/app > /repo/.env',
  "echo '1. page the oncall' > /runbook/steps.md",
  'echo PAGER=cat > /runbook/local.env',
  "echo '1. flip the flag' > /runbook/frozen/rollback.md",
  'echo AKIA-not-a-real-key > /vault/aws.token',
]

const LINES: [string, string, string][] = [
  ['oncall', 'cat /repo/service.py', 'the tree names cat, and allows it'],
  ['oncall', 'sort /repo/service.py', 'not named, so the root `*` refuses it'],
  ['oncall', 'ls /repo', 'the hide takes .env out of the listing'],
  ['oncall', 'cat /repo/.env', 'and answers absence, not refusal'],
  ['oncall', 'cat /runbook/local.env', 'the same pattern, anchored to /repo, reaches no further'],
  ['oncall', 'ls /vault', 'a deny leaves the name where it is'],
  ['oncall', 'cat /vault/aws.token', 'and refuses the read: cat decides for /vault'],
  ['oncall', 'rm /runbook/steps.md', 'rm asks under /runbook'],
  ['oncall', 'rm /runbook/frozen/rollback.md', "the mount's tree denies, and the stricter wins"],
  [
    'oncall',
    'cp /vault/aws.token /runbook/steps.md',
    "every path is judged: the source's deny wins",
  ],
  ['oncall', 'rm /repo/service.py', 'the mount section narrowed the mode'],
  ['auditor', 'ls /vault', 'hidden here, so the mount is not there at all'],
  ['auditor', 'cat /repo/.env', "the hide was the other role's, not the workspace's"],
  ['auditor', 'rm /runbook/steps.md', 'this tree does not name rm'],
  ['commander', 'sort /repo/service.py', 'no root deny, so every tool runs'],
  ['commander', 'wc -l /runbook/steps.md', 'including the ones no other role names'],
  ['commander', 'cat /vault/aws.token', 'and it is still not unrestricted: the deny runs'],
  [
    'commander',
    'rm /repo/service.py',
    "no mount section, so /repo keeps the workspace's write mode",
  ],
]

// The approval id is a digest of the session, cwd and words; it is
// stable, and it is noise here.
const ASK_ID = /\(ask [0-9a-f]+\)/

const dec = new TextDecoder()

/**
 * One line's outcome, as a reader of the table wants it: what came back,
 * or why nothing did.
 */
function answer(out: string, err: string, code: number): string {
  if (err !== '') {
    const first = err.replace(ASK_ID, '(ask ...)').split('\n')[0]
    return `[${code}] ${first}`
  }
  return `[${code}] ${out.split(/\s+/).filter(Boolean).join(' ')}`.trimEnd()
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/repo/': new RAMVFS(), '/runbook/': new RAMVFS(), '/vault/': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      // The one place this file differs from its Python twin: the
      // workspace takes parsed roles, and TypeScript has no runtime
      // model to tell a document from an already-parsed one, so the
      // document is validated here rather than in the constructor. The
      // YAML loader makes the same call.
      profiles: Object.fromEntries(
        Object.entries(PROFILES).map(([name, doc]) => [
          name,
          SessionProfile(doc, `profile \`${name}\``),
        ]),
      ),
    },
  )

  // A session that names no role is unrestricted, which is the host's
  // own view and the only place this seeding could run.
  for (const line of SEED) await ws.shell(line)

  for (const role of Object.keys(PROFILES)) ws.createSession(role, { profile: role })

  for (const [role, line, note] of LINES) {
    const res = await ws.shell(line, { sessionId: role })
    const out = res.stdout === null ? '' : dec.decode(res.stdout)
    const err = res.stderr === null ? '' : dec.decode(res.stderr)
    console.log(`${pad(role, 10)} ${pad(line, 42)} ${answer(out, err, res.exitCode)}`)
    console.log(`${pad('', 10)} ${pad('', 42)} ${note}`)
  }
}

await main()
