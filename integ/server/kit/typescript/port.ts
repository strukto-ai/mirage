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

import { resolve } from 'node:path'
import { KitError } from './errors.ts'

// One --port contract, replacing four: argparse-required, argparse default 0,
// hand-rolled process.argv.indexOf with an in-file DEFAULT_PORT, and none.
// 0 means "pick an ephemeral port and announce it".
export function parsePort(argv: string[] = process.argv.slice(2), fallback = 0): number {
  return parseFlagPort('--port', argv, fallback)
}

// The fixture a standalone fake seeds at startup, so one server binary can
// serve two scenarios without two launch scripts editing a config. `/reset`
// has taken a fixture name since the kit existed; this is the same name asked
// for once, before the socket opens.
export function parseFixture(argv: string[] = process.argv.slice(2)): string | undefined {
  const i = argv.indexOf('--fixture')
  if (i === -1) return undefined
  const raw = argv[i + 1]
  if (raw === undefined) throw new KitError('--fixture requires a value')
  return raw
}

// Where this fake reads its fixtures from, absolute after resolution. It is a
// launch argument and not a request field on purpose: a harness pointing a
// fake at its own fixture tree is the operator, and used to have to bind-mount
// files into the checkout to say so, one file at a time and then whole
// directories once fakes began seeding from `sourceDir`. What a REQUEST may
// choose is unchanged -- a name, matched against NAME_RE and re-checked to
// resolve inside this root.
export function parseFixtureRoot(argv: string[] = process.argv.slice(2)): string | undefined {
  const i = argv.indexOf('--fixture-root')
  if (i === -1) return undefined
  const raw = argv[i + 1]
  if (raw === undefined) throw new KitError('--fixture-root requires a value')
  return resolve(raw)
}

// Every flag the kit itself understands. An argument outside this set is a
// caller asking for something the fake will not do.
// The flags EVERY fake takes. A fake that serves a second protocol on a second
// socket declares its own beside these rather than adding them here, because a
// flag in this set is one every other fake's launcher silently accepts and
// silently ignores.
const KNOWN_FLAGS = new Set(['--port', '--fixture', '--fixture-root'])

// Refused, not ignored, and that covers a bare word as well as a flag.
// `parsePort` and `parseFixture` each scan argv for their own flag and skip
// everything else, so a fake launched with anything they do not recognize
// announced a healthy server seeded with the DEFAULT fixture: the caller asked
// for one world and silently got another, which is the failure a fake exists to
// make impossible. github is the worked example, since the fake it replaced
// took a repeatable `--repo owner/name=<dir>` plus `--metadata`, `--commits`
// and `--no-create-repos`, and none of those survive here.
//
// A POSITIONAL is refused for the same reason and is the likelier slip:
// `main.ts --port 5098 cli` is `--fixture cli` with the flag dropped, and
// skipping it served v1 under a launch line that reads as asking for cli. So
// the scan consumes a known flag's value by POSITION and treats everything
// else as unexpected, whatever it looks like.
export function checkArgv(argv: string[] = process.argv.slice(2), extra: string[] = []): void {
  const known = new Set([...KNOWN_FLAGS, ...extra])
  const unexpected: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (known.has(arg)) {
      i += 1
      continue
    }
    unexpected.push(arg)
  }
  if (unexpected.length > 0) {
    throw new KitError(
      `unexpected argument${unexpected.length > 1 ? 's' : ''}: ${unexpected.join(', ')}. ` +
        `This fake takes only ${[...known].sort().join(' and ')}; ` +
        `seed a scenario by naming a fixture under integ/fixtures/<service>/.`,
    )
  }
}

// A flag's value by position, for a fake reading one of its OWN flags.
// `parsePort` is this function bound to `--port`, so every socket's port is
// read under ONE rule. The rule is strict on purpose: the fallback answers
// only an ABSENT flag, a flag typed with no value is refused rather than
// silently defaulted, and the value is digits-or-nothing because parseInt's
// tolerated suffix ("3025junk") announced a healthy listener on a port the
// launch line never asked for.
export function parseFlagPort(
  flag: string,
  argv: string[] = process.argv.slice(2),
  fallback = 0,
): number {
  const at = argv.indexOf(flag)
  if (at === -1) return fallback
  const raw = argv[at + 1]
  if (raw === undefined) throw new KitError(`${flag} requires a value`)
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port > 65535) {
    throw new KitError(`${flag} must be a port number, got ${raw}`)
  }
  return port
}
