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

import { describe, expect, it } from 'vitest'
import { EmailConfig } from '../../core/email/config.ts'
import { parseConfigWithSchema } from '../secrets.ts'
import { EmailVFS } from './email.ts'

const MINIMAL = { imapHost: 'imap.example', smtpHost: 'smtp.example', username: 'u', password: 'p' }

describe('EmailVFS', () => {
  it('applies the documented defaults to the minimal config', () => {
    const vfs = new EmailVFS(MINIMAL)
    expect(vfs.config).toMatchObject({
      imapPort: 993,
      smtpPort: 587,
      useSsl: true,
      maxMessages: 200,
      saveCopy: true,
      sentFolder: null,
      trashFolder: null,
    })
  })

  it('keeps a config the registry already parsed unchanged', () => {
    const once = parseConfigWithSchema(EmailConfig, {
      imap_host: 'imap.example',
      imap_port: 143,
      smtp_host: 'smtp.example',
      username: 'u',
      password: 'p',
      use_ssl: false,
      sent_folder: 'Sent Items',
    })
    expect(new EmailVFS(once).config).toEqual(once)
  })
})
