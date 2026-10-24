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
  parseConfigWithSchema,
  redactConfigWithSchema,
  secretStr,
  z,
} from '@struktoai/mirage-core/vfs/secrets'
import { WALK_LIMIT } from '@struktoai/mirage-core/vfs/constants'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/vfs/secrets'

// Doubles as the himalaya CLI's configModel: parse applies the same
// defaults buildEmailConfig fills in, and secretStr marks the password
// for snapshot redaction.
export const EmailConfigSchema = z.object({
  imapHost: z.string().describe('IMAP server hostname.'),
  imapPort: z.number().default(993).describe('IMAP server port.'),
  smtpHost: z.string().describe('SMTP server hostname `himalaya` sends mail through.'),
  smtpPort: z
    .number()
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
    .default(200)
    .describe(
      "How many of a folder's newest messages the mount lists and `grep` searches, and the window `himalaya envelope list` and `search` page through.",
    ),
  walkLimit: z.number().int().min(-1).default(WALK_LIMIT).meta({
    description:
      'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit and reads every message without asking the server (IMAP `SEARCH TEXT`), which searches headers and body, not the mounted JSON.',
    default: 1000,
  }),
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
})

export type EmailConfig = ConfigOf<typeof EmailConfigSchema>

export type EmailConfigRedacted = RedactedConfig<EmailConfig, 'password'>

export function redactEmailConfig(config: EmailConfig): EmailConfigRedacted {
  return redactConfigWithSchema(EmailConfigSchema, config) as unknown as EmailConfigRedacted
}

// What a caller writes, which is the schema before its defaults land.
export type EmailConfigInput = z.input<typeof EmailConfigSchema>

export function buildEmailConfig(input: EmailConfigInput): EmailConfig {
  return {
    imapHost: input.imapHost,
    imapPort: input.imapPort ?? 993,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort ?? 587,
    username: input.username,
    password: input.password,
    useSsl: input.useSsl ?? true,
    maxMessages: input.maxMessages ?? 200,
    walkLimit: input.walkLimit ?? WALK_LIMIT,
    saveCopy: input.saveCopy ?? true,
    sentFolder: input.sentFolder ?? null,
  }
}

export function normalizeEmailConfig(input: Record<string, unknown>): EmailConfig {
  return parseConfigWithSchema(EmailConfigSchema, input)
}
