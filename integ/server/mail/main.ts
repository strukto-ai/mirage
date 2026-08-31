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
  announceFor,
  checkArgv,
  emit,
  parseFixture,
  parseFixtureRoot,
  parseFlagPort,
  parsePort,
  start,
} from '../kit/typescript/index.ts'
import { startMailArms } from './arms.ts'
import {
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_PORT,
  IMAP_FLAG,
  MAIL_FLAGS,
  SMTP_FLAG,
  mailDomain,
} from './config.ts'
import { mailFake } from './fake.ts'

// Three listeners, one world. The kit's own HTTP server answers /reset and
// health; IMAP and SMTP are the surface every consumer actually uses. They are
// started here rather than inside `serve()` because the kit is an HTTP kit --
// a line protocol is this fake's business, and pushing two sockets into the
// shared launcher would make every other fake carry the concept.
//
// The extra flags are DECLARED to the shared scan rather than re-parsed
// here. This launcher used to carry its own copy of that scan, which is one
// rule in two places: the copy had to be kept in step with the kit's by hand,
// and the moment it drifted a flag would be accepted here and refused there.
// The list lives in config.ts beside the readers so the same drift cannot
// open between the preflight and them. `mailDomain` runs once eagerly: it
// validates its value, and a bad domain must refuse the launch here, not
// bounce every LOGIN after the ports are already announced.
const argv = process.argv.slice(2)
checkArgv(argv, MAIL_FLAGS)
mailDomain(argv)

// `start`, not `serve`: serve() announces one endpoint and installs its own
// signal handlers, and this fake has three listeners to announce and tear down
// together.
const http = await start(
  mailFake,
  parsePort(argv, mailFake.config.defaultPort),
  parseFixture(argv),
  parseFixtureRoot(argv),
)
const arms = await startMailArms(
  http.runtime,
  parseFlagPort(IMAP_FLAG, argv, DEFAULT_IMAP_PORT),
  parseFlagPort(SMTP_FLAG, argv, DEFAULT_SMTP_PORT),
)
// The FIRST line is the HTTP endpoint, because that is the line the runners
// parse and it is where /reset lives. The next two name the line-protocol
// ports.
emit(announceFor('mail', http.port))
for (const a of arms.announces) emit(a)

const bye = (): void => {
  void Promise.all([arms.close(), http.close()]).then(() => {
    process.exit(0)
  })
}
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
