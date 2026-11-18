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

import { TimeoutConfig } from '../api/config.ts'
import type { ConfigOf } from '../../vfs/secrets.ts'
import { parseConfigWithSchema, secretStr, z } from '../../vfs/secrets.ts'

// The mount and the himalaya CLI share this schema and its secret markers.
export const EmailConfig = z.object({
  ...TimeoutConfig.shape,
  imapHost: z.string().describe('IMAP server hostname.'),
  imapPort: z.number().int().default(993).describe('IMAP server port.'),
  smtpHost: z.string().describe('SMTP server hostname `himalaya` sends mail through.'),
  smtpPort: z
    .number()
    .int()
    .default(587)
    .describe(
      'SMTP server port. `465` uses implicit TLS; any other port starts in plaintext and upgrades with STARTTLS when the server offers it.',
    ),
  username: z.string().describe('Login for both IMAP and SMTP, usually the email address.'),
  password: secretStr().describe('Password or app password for `username`.'),
  useSsl: z
    .boolean()
    .default(true)
    .describe(
      'Speak TLS from the first byte of the IMAP connection (IMAPS); off connects in plaintext. SMTP follows `smtpPort` instead.',
    ),
  maxMessages: z
    .number()
    .int()
    .default(200)
    .describe(
      "How many of a folder's newest messages the mount lists and `grep` searches, and the window `himalaya envelope list` and `search` page through.",
    ),
  /**
   * Upstream himalaya's message.send.save-copy, whose default is true
   * since pimalaya/himalaya#536.
   */
  saveCopy: z
    .boolean()
    .default(true)
    .describe(
      "After `himalaya` sends a message, append a copy to `sentFolder`, as upstream himalaya's `message.send.save-copy`. Off saves a copy only when `--save` names a mailbox.",
    ),
  sentFolder: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'Mailbox a sent copy goes to. Unset asks the server for the mailbox tagged `\\Sent` and falls back to `Sent`.',
    ),
  trashFolder: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Mailbox `himalaya message delete` moves messages to, as upstream's `mailbox.alias.trash`. Unset asks the server for the mailbox tagged `\\Trash` and falls back to `Trash`.",
    ),
})

export type EmailConfig = ConfigOf<typeof EmailConfig>

// What a caller writes, which is the schema before its defaults land.
export type EmailConfigInput = z.input<typeof EmailConfig>

export function buildEmailConfig(input: EmailConfigInput): EmailConfig {
  return parseConfigWithSchema(EmailConfig, input)
}
