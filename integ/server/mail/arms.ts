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

import { authorityHost, advertiseHost } from '../kit/typescript/index.ts'
import type { Arm, Runtime } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { startImapServer } from './imap.ts'
import { startSmtpServer } from './smtp.ts'

// The two sockets this fake serves beside HTTP, started together because they
// share one runtime and have to be torn down together. Both `main.ts` and the
// multi-fake launcher call this rather than each opening the sockets itself:
// the announce tokens and the teardown order are the kind of detail that reads
// as identical in two places right up until one of them is edited.
//
// The tokens carry their own schemes rather than going through `announceFor`,
// which builds an http:// URL: `http://host:3143` for an IMAP port is a working
// string that says the wrong thing, and a harness copying it into a client's
// config would be pointing an IMAP client at a scheme it does not speak.
export async function startMailArms(
  runtime: Runtime<C>,
  imapPort: number,
  smtpPort: number,
): Promise<Arm> {
  const imap = await startImapServer(runtime, imapPort)
  const smtp = await startSmtpServer(runtime, smtpPort)
  const host = authorityHost(advertiseHost())
  return {
    announces: [
      { token: 'MAIL_IMAP_URL', url: `imap://${host}:${String(imap.port)}` },
      { token: 'MAIL_SMTP_URL', url: `smtp://${host}:${String(smtp.port)}` },
    ],
    close: async () => {
      await Promise.all([imap.close(), smtp.close()])
    },
  }
}
