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

import { KitError, parseConfig, schemaFor } from '../kit/typescript/index.ts'
import type { PrismaClient } from '../../generated/mail/index.js'

export type C = PrismaClient

// This fake serves no HTTP routes of its own: it speaks IMAP and SMTP on two
// sockets of their own, and the kit's server answers only /reset and health.
// Everything else the kit gives -- the per-run SQLite file, the tenant column,
// the seeder, the write queue -- applies unchanged, which is the whole reason
// the line protocol is worth writing rather than running GreenMail.
export const config = parseConfig({
  service: 'mail',
  schema: schemaFor('mail'),
  // The kit's HTTP port. IMAP and SMTP take their own, below.
  defaultPort: 5085,
  tenantKind: 'pk-column',
})

// The two line-protocol ports, which are separate from the kit's HTTP one and
// are moved together with it by --imap-port / --smtp-port. The defaults are
// GreenMail's, so a harness that already points at 3143/3025 keeps working.
export const DEFAULT_IMAP_PORT = 3143
export const DEFAULT_SMTP_PORT = 3025

// Every flag this fake takes beyond the kit's own, declared once so the
// launcher's preflight and the readers below cannot drift: a flag missing
// from this list is accepted by its reader and refused at startup.
export const IMAP_FLAG = '--imap-port'
export const SMTP_FLAG = '--smtp-port'
export const MAIL_DOMAIN_FLAG = '--mail-domain'
export const MAIL_FLAGS = [IMAP_FLAG, SMTP_FLAG, MAIL_DOMAIN_FLAG]

// Every account starts with these, because every real provider does and
// GreenMail does not: himalaya files a copy of each sent message into a sent
// mailbox, and on GreenMail the harness had to create one by hand after every
// reset or the copy had nowhere to land.
export const DEFAULT_MAILBOXES = ['INBOX', 'Sent']

// The mailbox a bare LOGIN selects nothing in. INBOX is the one name RFC 3501
// fixes, and it is case-insensitive; every other name is compared verbatim.
export const INBOX = 'INBOX'

// An account is addressed as `<local>@<domain>` on the wire and stored under
// `<local>` as the kit's tenant, because the kit's names are
// `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and an `@` is not in that set. Widening the
// shared pattern for one fake would be the wrong repair: run and tenant names
// ride URLs and path segments everywhere else.
//
// Dropping the domain would make `a@one.test` and `a@two.test` one account, so
// the domain is not dropped, it is CHECKED: one domain is served, a login from
// any other is refused by name, and the collision cannot happen. `--mail-domain`
// moves it, which is what a deployment addressing `@mcp.com` needs.
export const DEFAULT_MAIL_DOMAIN = 'example.com'

// Who a manifest entry belongs to when it does not say. The manifest is shared
// with the seeder this fake replaces, and there `account` defaulted to the
// PRIMARY address -- so an entry without one is integ's mail, not "the mail of
// whichever account is being seeded right now". Defaulting it to the tenant
// gave every extra account a copy of the primary's inbox, which reads as
// working (mail is there, counts are plausible) and quietly destroys the one
// thing the extra accounts exist to prove: that a CLI install bound to alpha
// cannot see integ's mail. `extras.primary` overrides it for a corpus whose
// manifest is centred on somebody else.
export const DEFAULT_PRIMARY = 'integ'

// One label or dot-joined labels, alphanumeric with inner hyphens. Whatever
// the source -- flag, env or default -- the value is checked here, so a flag
// with no value or a word that can never equal an address's domain part is a
// loud refusal at startup rather than a server every login bounces off.
const DOMAIN_RE =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/

export function mailDomain(argv: string[] = process.argv.slice(2)): string {
  const i = argv.indexOf(MAIL_DOMAIN_FLAG)
  const named =
    i === -1 ? (process.env.MIRAGE_MAIL_DOMAIN ?? DEFAULT_MAIL_DOMAIN) : (argv[i + 1] ?? '')
  if (!DOMAIN_RE.test(named)) {
    throw new KitError(`${MAIL_DOMAIN_FLAG} takes a domain, got ${JSON.stringify(named)}`)
  }
  return named
}

export interface Address {
  local: string
  domain: string
}

export function splitAddress(raw: string): Address | null {
  const at = raw.lastIndexOf('@')
  if (at <= 0 || at === raw.length - 1) return null
  return { local: raw.slice(0, at), domain: raw.slice(at + 1).toLowerCase() }
}
