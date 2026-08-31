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

import { readFileSync } from 'node:fs'
import { announceFor, emit, start } from '../kit/typescript/index.ts'
import type { Announce, Arm, Fake, JsonValue, MinimalClient } from '../kit/typescript/index.ts'
import { KitError } from '../kit/typescript/errors.ts'
import { boxFake } from '../box/fake.ts'
import { databricksFake } from '../databricks/fake.ts'
import { difyFake } from '../dify/fake.ts'
import { discordFake } from '../discord/fake.ts'
import { dropboxFake } from '../dropbox/fake.ts'
import { gcsFake } from '../gcs/fake.ts'
import { githubFake } from '../github/fake.ts'
import { gwsFake } from '../gws/fake.ts'
import { hfFake } from '../hf/fake.ts'
import { hfHubFake } from '../hf_hub/fake.ts'
import { startHubArms } from '../hf_hub/arms.ts'
import { httpFake } from '../http/fake.ts'
import { linearFake } from '../linear/fake.ts'
import { mailFake } from '../mail/fake.ts'
import { startMailArms } from '../mail/arms.ts'
import { mem0Fake } from '../mem0/fake.ts'
import { notionFake } from '../notion/fake.ts'
import { onedriveFake } from '../onedrive/fake.ts'
import { slackFake } from '../slack/fake.ts'
import { trelloFake } from '../trello/fake.ts'

// ONE process hosting several fakes, each on its OWN port.
//
// The merge is of PROCESSES, not of URLs. Every fake keeps its own listener and
// answers the vendor's own absolute paths at its own root, so a client cannot
// tell a launched fake from a standalone one. Putting them all behind one port
// with a path prefix per fake would be the other design, and it is not this
// one: a client SDK joins `/repos/o/r` against its base URL, and the standard
// join DISCARDS a path component, so the prefix would vanish silently and the
// request would land on whichever fake owns that path. The kit already pays
// that tax once for `/_run/<id>` -- `ctx.runPrefix` exists so handlers can put
// the prefix back onto links they mint -- and a second prefix would mean every
// mint site carrying two, forever.
//
// What this buys is the launch: one node startup instead of N, one stream of
// announce lines instead of N log files each polled by its own loop, and ports
// that can be left at 0 for the OS to choose rather than written down by hand.
// What it costs is fault isolation: an unhandled rejection here takes down
// every fake in the process, where N processes lose only one. That trade is
// why this is opt-in and why the per-fake `main.ts` entry points all stay.

interface Instance {
  name: string
  announces: Announce[]
  close: () => Promise<void>
}

interface EntryOpts {
  port: number
  fixture: string | undefined
  fixtureRoot: string | undefined
  token: string | undefined
  extras: Record<string, JsonValue>
}

// A registry value is a THUNK, not the fake itself. `Fake<C>` is generic in its
// Prisma client, and those types differ per service with no useful supertype,
// so a map holding them directly would need a cast at every read. Closing over
// the concrete fake inside the thunk erases the parameter with no cast at all.
type Entry = (opts: EntryOpts) => Promise<Instance>

function announceOf(service: string, port: number, token: string | undefined): Announce {
  const a = announceFor(service, port)
  return token === undefined ? a : { token, url: a.url }
}

// The common case: one HTTP listener, one announce line.
function plain<C extends MinimalClient>(fake: Fake<C>): Entry {
  return async (o: EntryOpts): Promise<Instance> => {
    const started = await start(fake, o.port, o.fixture, o.fixtureRoot)
    return {
      name: fake.config.service,
      announces: [announceOf(fake.config.service, started.port, o.token)],
      close: started.close,
    }
  }
}

// A fake that also serves a non-HTTP listener. The arm is started from the SAME
// runtime, which is the whole point: two sockets over one store.
function withArms<C extends MinimalClient>(
  fake: Fake<C>,
  arms: (runtime: Awaited<ReturnType<typeof start<C>>>['runtime'], o: EntryOpts) => Promise<Arm>,
): Entry {
  return async (o: EntryOpts): Promise<Instance> => {
    const started = await start(fake, o.port, o.fixture, o.fixtureRoot)
    // The HTTP listener is already up by the time the arm is asked for, so an
    // arm that refuses its port has to take the listener down with it. Leaving
    // it up leaks a socket and a SQLite pool that nothing holds a handle to.
    let arm: Arm
    try {
      arm = await arms(started.runtime, o)
    } catch (e) {
      await started.close()
      throw e
    }
    return {
      name: fake.config.service,
      announces: [announceOf(fake.config.service, started.port, o.token), ...arm.announces],
      close: async () => {
        await arm.close()
        await started.close()
      },
    }
  }
}

function portOf(extras: Record<string, JsonValue>, key: string): number {
  const v = extras[key]
  if (v === undefined) return 0
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 65535) {
    throw new KitError(`${key} must be a port number, got ${JSON.stringify(v)}`)
  }
  return v
}

// Every kit fake, which is a claim the selftest checks against the server/
// directory listing rather than a hope: a fake added to server/ and forgotten
// here would be startable alone but not hostable, and nothing else would say
// so. notion is hostable but with the caveat its own main.ts is free of: the
// vendored upstream MCP server beside it is a separate process this launcher
// does not manage.
const REGISTRY: Record<string, Entry> = {
  box: plain(boxFake),
  databricks: plain(databricksFake),
  dify: plain(difyFake),
  discord: plain(discordFake),
  dropbox: plain(dropboxFake),
  gcs: plain(gcsFake),
  github: plain(githubFake),
  gws: plain(gwsFake),
  hf: plain(hfFake),
  http: plain(httpFake),
  linear: plain(linearFake),
  mem0: plain(mem0Fake),
  notion: plain(notionFake),
  onedrive: plain(onedriveFake),
  slack: plain(slackFake),
  trello: plain(trelloFake),
  'hf-hub': withArms(hfHubFake, async (runtime, o) =>
    startHubArms(runtime, portOf(o.extras, 'mcpPort')),
  ),
  mail: withArms(mailFake, async (runtime, o) =>
    startMailArms(runtime, portOf(o.extras, 'imapPort'), portOf(o.extras, 'smtpPort')),
  ),
}

// The config is a MAP keyed by an instance name, not a list of service names,
// because the same fake runs twice at once: CI serves github seeded `cli` for
// the gh battery and github seeded `empty` for the watch battery. The key names
// the instance, `fake` names which one to build when the two differ, and
// `token` renames the announce line so the second instance does not overwrite
// the first's environment variable.
interface Spec {
  fake?: string
  fixture?: string
  fixtureRoot?: string
  port?: number
  token?: string
  [extra: string]: JsonValue | undefined
}

function specOf(raw: JsonValue, name: string): Spec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KitError(`${name}: each entry must be an object, got ${JSON.stringify(raw)}`)
  }
  return raw as Spec
}

function str(spec: Spec, key: string): string | undefined {
  const v = spec[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new KitError(`${key} must be a string`)
  return v
}

// All-or-nothing. A config naming ten fakes where the seventh is misspelled
// used to leave six of them listening with nobody holding a handle to close
// them: the caller sees only the exception, so the sockets and their SQLite
// pools survive until the process dies. That reads as a port already in use on
// the next attempt, which is a long way from the typo that caused it.
// Every name the registry knows, so a config can be checked without starting
// anything. `ci/fakes.json` is validated this way: a config file that names a
// fake nobody registered should fail in a selftest, not on the runner.
export function knownFakes(): string[] {
  return Object.keys(REGISTRY).sort()
}

export async function launch(config: Record<string, JsonValue>): Promise<Instance[]> {
  const out: Instance[] = []
  try {
    return await launchAll(config, out)
  } catch (e) {
    for (const inst of out) await inst.close()
    throw e
  }
}

async function launchAll(config: Record<string, JsonValue>, out: Instance[]): Promise<Instance[]> {
  for (const [name, raw] of Object.entries(config)) {
    // JSON has no comments and this config has three pinned ports that need a
    // stated reason, so a leading underscore marks a key that is prose. It is
    // the ONLY key that is skipped: every other name the registry does not know
    // is still a hard failure, because "silently ignored" is the behaviour this
    // launcher exists to not have.
    if (name.startsWith('_')) continue
    const spec = specOf(raw, name)
    const which = str(spec, 'fake') ?? name
    const entry = REGISTRY[which]
    if (entry === undefined) {
      throw new KitError(
        `${name}: no fake named ${which}. Known: ${Object.keys(REGISTRY).sort().join(', ')}`,
      )
    }
    // Started one at a time rather than in parallel. Seeding writes SQLite, and
    // a failure has to name the fake that caused it: Promise.all would report
    // the first rejection with nine other startups still in flight.
    out.push(
      await entry({
        port: portOf(spec as Record<string, JsonValue>, 'port'),
        fixture: str(spec, 'fixture'),
        fixtureRoot: str(spec, 'fixtureRoot'),
        token: str(spec, 'token'),
        extras: spec as Record<string, JsonValue>,
      }),
    )
  }
  // A config naming nothing is a broken config, not a healthy empty fleet:
  // returning [] would announce no URL lines and wait for a signal, turning
  // a malformed file into a startup timeout instead of an error.
  if (out.length === 0) {
    throw new KitError('the config names no fakes: every key is prose or the file is empty')
  }
  return out
}

function configPath(argv: string[]): string {
  const i = argv.indexOf('--config')
  if (i === -1 || argv[i + 1] === undefined) {
    throw new KitError('--config <path> is required, naming a JSON map of instances')
  }
  return argv[i + 1] ?? ''
}

// Entry point only when run directly, so the selftest can import `launch`
// without this block taking over the process.
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const raw = JSON.parse(readFileSync(configPath(process.argv.slice(2)), 'utf8')) as JsonValue
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KitError('config must be a JSON object mapping instance names to specs')
  }
  const started = await launch(raw)
  for (const inst of started) for (const a of inst.announces) emit(a)
  const bye = (): void => {
    void Promise.all(started.map((i) => i.close())).then(() => {
      process.exit(0)
    })
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
