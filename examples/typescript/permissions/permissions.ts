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

import { MountMode, RAMVFS, Workspace, parseSessionProfile } from '@struktoai/mirage-node'

// An incident-response workspace: the service tree, the runbooks the
// oncall works from, and the credentials nobody reads by hand.
//
// Three roles read the same three mounts and see three different
// filesystems. Every refusal below comes from one of two orderings, and
// the point of the example is that they are different orderings:
//
//   the command axis   a rule naming no path is read by verb alone,
//                      deny before ask, and the allow list decides
//                      whether the word is a command at all.
//   the path axis      a rule carrying paths is read by anchor depth,
//                      the number of literal components before its
//                      first wildcard. /runbook/frozen/* is 2 and
//                      /runbook/* is 1, so the deeper one wins wherever
//                      both reach, whichever verb it carries.
//
// Hiding is neither: it is not a refusal at all. A hidden path answers
// ENOENT, so the role never learns the name; a denied path stays in the
// listing and fails when read. /vault is denied for the oncall and
// hidden for the auditor, which is the same three files seen two ways.
//
// The third role, the commander, states no allow list, which is how a
// role says "every tool". That is the opposite of a deny list and worth
// seeing beside one: the list is not a filter over some default set, it
// IS the set, so omitting it installs everything and an empty one
// installs nothing. Its rules still run.

const PROFILES = {
  oncall: {
    commands: {
      // The allow list installs the tools. A word missing from it is
      // not a command at all: `sort` is `command not found`, not
      // `permission denied`.
      allow: ['ls', 'cat', 'grep', 'rm', 'cp'],
      ask: [
        {
          reason: 'a runbook edit needs a nod',
          // Anchor depth 1: /runbook, then a wildcard.
          commands: { rm: ['/runbook/*'], cp: ['/runbook/*'] },
        },
      ],
      deny: [
        {
          reason: 'credentials are never read by hand',
          // A rule with paths and no command reaches the op door too,
          // so FUSE and the cache cannot go around it.
          paths: ['/vault/*'],
        },
      ],
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
        commands: {
          deny: [
            {
              reason: 'the rollback plan is frozen',
              // Anchor depth 2, so it outranks the ask at 1 that also
              // covers these files. Writing it in the mount section is
              // not what makes it win; the extra component is.
              commands: { rm: ['/runbook/frozen/*'] },
            },
          ],
        },
      },
    },
  },
  auditor: {
    // No rm, no cp: this role cannot be talked into a write, because
    // there is no rule to argue with.
    commands: { allow: ['ls', 'cat', 'grep'] },
    // Hidden, where the oncall has it denied. Same mount, same files,
    // two different answers to `ls /vault`.
    paths: { hide: ['/vault'] },
  },
  commander: {
    commands: {
      // No allow list, which installs every command mirage ships, this
      // role's own `sort` and `wc` included. `allow: ['*']` says the
      // same thing out loud; `allow: []` says the opposite and installs
      // nothing. What it does not say is "unrestricted": the deny below
      // still runs, and so would an ask.
      deny: [{ reason: 'credentials are never read by hand', paths: ['/vault/*'] }],
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
  ['oncall', 'cat /repo/service.py', 'the allow list installed cat'],
  ['oncall', 'sort /repo/service.py', 'unlisted: not a command, not a refusal'],
  ['oncall', 'ls /repo', 'the hide takes .env out of the listing'],
  ['oncall', 'cat /repo/.env', 'and answers absence, not refusal'],
  ['oncall', 'cat /runbook/local.env', 'the same pattern, anchored to /repo, reaches no further'],
  ['oncall', 'ls /vault', 'a deny leaves the name where it is'],
  ['oncall', 'cat /vault/aws.token', 'and refuses the read: paths, depth 1'],
  ['oncall', 'rm /runbook/steps.md', 'ask at depth 1'],
  ['oncall', 'rm /runbook/frozen/rollback.md', 'deny at depth 2 outranks it'],
  [
    'oncall',
    'cp /vault/aws.token /runbook/steps.md',
    "every operand is judged: the source's deny wins",
  ],
  ['oncall', 'rm /repo/service.py', 'the mount section narrowed the mode'],
  ['auditor', 'ls /vault', 'hidden here, so the mount is not there at all'],
  ['auditor', 'cat /repo/.env', "the hide was the other role's, not the workspace's"],
  ['auditor', 'rm /runbook/steps.md', 'no rm in this allow list'],
  ['commander', 'sort /repo/service.py', 'no allow list, so every tool is installed'],
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
          parseSessionProfile(doc, `profile \`${name}\``),
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
