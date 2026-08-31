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
import { Prisma, PrismaClient } from '../../generated/mail/index.js'
import { fixturePath } from '../kit/typescript/index.ts'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { DEFAULT_MAILBOXES, DEFAULT_PRIMARY, config, splitAddress } from './config.ts'
import type { C } from './config.ts'
import { buildRfc822, type MailEntry } from './rfc822.ts'
import { appendMessage, canonicalName, createMailbox, mailboxOf } from './store.ts'

// The fixture states MAILBOXES; the messages come from the shared mail manifest
// under integ/fixtures/email/. That split is deliberate: the manifest is the
// same file the GreenMail seeder already reads, written in terms a person can
// edit (from, subject, body, attachments), and it is expanded into RFC822 here
// by the one builder both paths use. Restating those messages as rows of
// base64 in a kit fixture would fork the corpus.
export const MANIFEST_DIR = 'email'

export const mailFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  seedRoots: { mailboxes: 'MailMailbox' },
  // `accounts` is the one thing a fixture has to say that the manifest cannot:
  // which usernames exist. The manifest names an account per message, but an
  // account with no mail still has to be loginable -- the CLI installs each
  // take one, and two of the three start empty.
  afterSeed: async (db, tenant, _counts, extras, fixtureRoot) => {
    for (const name of DEFAULT_MAILBOXES) {
      if ((await mailboxOf(db, tenant, name)) === null) await createMailbox(db, tenant, name)
    }
    const named = extras.manifest
    const manifest = typeof named === 'string' && named !== '' ? named : 'v1'
    // The manifest is a NAME, never a path: it rides an unauthenticated /reset
    // body, and joined verbatim it chose which host-side .json the fake read.
    // `fixturePath` is the same check every ordinary fixture name passes.
    const path = fixturePath(MANIFEST_DIR, manifest, fixtureRoot)
    // ONLY a missing file is a legal empty world, which is what a run seeded
    // just to hold a CLI account wants. Catching everything meant a manifest
    // that was present but malformed -- or a name with a typo in it, which is
    // the same thing from here -- seeded an empty mailbox and reported success,
    // so every assertion against it passed vacuously. That is the exact failure
    // the unseeded-account refusal in login() exists to prevent, reintroduced
    // one layer up.
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return
    }
    const entries = JSON.parse(raw) as MailEntry[]
    const primaryRaw = extras.primary
    const primary =
      typeof primaryRaw === 'string' && primaryRaw !== '' ? primaryRaw : DEFAULT_PRIMARY
    for (const entry of entries) {
      // The manifest names accounts by ADDRESS; the tenant is the local part.
      // An entry that names none belongs to the PRIMARY account, never to the
      // tenant currently being seeded -- see DEFAULT_PRIMARY.
      const owner =
        entry.account === undefined ? primary : (splitAddress(entry.account)?.local ?? '')
      if (owner !== tenant) continue
      const folder = canonicalName(entry.folder ?? 'INBOX')
      if ((await mailboxOf(db, tenant, folder)) === null) await createMailbox(db, tenant, folder)
      await appendMessage(
        db,
        tenant,
        folder,
        Buffer.from(buildRfc822(entry), 'utf8'),
        entry.seen === true ? ['\\Seen'] : [],
        Date.parse(entry.date),
      )
    }
  },
  routes: () => [],
}
