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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EmailAccessor } from '../../../../accessor/email.ts'
import type { EmailConfig } from '../../../../core/email/config.ts'
import { deliver, resolveSentFolder, saveSentCopy } from './deliver.ts'

const sendRawMock = vi.hoisted(() => vi.fn())

vi.mock('./smtp.ts', () => ({ sendRaw: sendRawMock }))

const RAW = new TextEncoder().encode('From: me@x\r\nTo: a@b.com\r\nSubject: Hi\r\n\r\nyo')

const GMAIL = [
  { pathAsListed: 'INBOX', specialUse: undefined },
  { pathAsListed: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
  { pathAsListed: '[Gmail]/Trash', specialUse: '\\Trash' },
]
const PLAIN = [
  { pathAsListed: 'INBOX', specialUse: undefined },
  { pathAsListed: 'Archive', specialUse: undefined },
]

const listMock = vi.fn()
const appendMock = vi.fn()

function config(overrides: Partial<EmailConfig> = {}): EmailConfig {
  return {
    imapHost: 'h',
    imapPort: 993,
    smtpHost: 'h',
    smtpPort: 587,
    username: 'u',
    password: 'p',
    useSsl: false,
    maxMessages: 200,
    saveCopy: true,
    sentFolder: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  listMock.mockResolvedValue(PLAIN)
  appendMock.mockResolvedValue({ destination: 'Sent' })
  sendRawMock.mockResolvedValue({ to: [{ name: '', email: 'a@b.com' }], subject: 'Hi' })
  vi.spyOn(EmailAccessor.prototype, 'getImap').mockResolvedValue({
    list: listMock,
    append: appendMock,
  } as unknown as Awaited<ReturnType<EmailAccessor['getImap']>>)
  vi.spyOn(EmailAccessor.prototype, 'close').mockResolvedValue()
})

describe('resolveSentFolder', () => {
  it('takes the mailbox the server tags \\Sent', async () => {
    listMock.mockResolvedValue(GMAIL)
    expect(await resolveSentFolder(new EmailAccessor(config()), null)).toBe('[Gmail]/Sent Mail')
  })

  it('falls back to Sent when the server tags nothing', async () => {
    expect(await resolveSentFolder(new EmailAccessor(config()), null)).toBe('Sent')
  })

  it('lets a configured folder win, without asking the server', async () => {
    listMock.mockResolvedValue(GMAIL)
    expect(await resolveSentFolder(new EmailAccessor(config()), 'Archive')).toBe('Archive')
    expect(listMock).not.toHaveBeenCalled()
  })
})

describe('saveSentCopy', () => {
  it('appends the message seen, and closes the accessor', async () => {
    listMock.mockResolvedValue(GMAIL)
    expect(await saveSentCopy(config(), RAW)).toBe('[Gmail]/Sent Mail')
    expect(appendMock).toHaveBeenCalledWith('[Gmail]/Sent Mail', Buffer.from(RAW), ['\\Seen'])
    expect(EmailAccessor.prototype.close).toHaveBeenCalled()
  })

  it('names the mailbox when the server refuses', async () => {
    appendMock.mockResolvedValue(false)
    await expect(saveSentCopy(config(), RAW)).rejects.toThrow('Sent: the server refused')
    expect(EmailAccessor.prototype.close).toHaveBeenCalled()
  })
})

describe('deliver', () => {
  it('sends, then saves', async () => {
    const { parsed, warning } = await deliver(config(), RAW)
    expect(sendRawMock).toHaveBeenCalledWith(expect.anything(), RAW)
    expect(parsed.subject).toBe('Hi')
    expect(warning).toBe('')
    expect(appendMock).toHaveBeenCalledOnce()
  })

  it('sends and touches no mailbox when saveCopy is off', async () => {
    const { warning } = await deliver(config({ saveCopy: false }), RAW)
    expect(sendRawMock).toHaveBeenCalledOnce()
    expect(warning).toBe('')
    expect(appendMock).not.toHaveBeenCalled()
  })

  it('warns rather than raising when the copy fails', async () => {
    // The message is already on the wire, so a failed copy must not
    // become a failed send: a non-zero exit invites a retry that would
    // send it a second time.
    appendMock.mockRejectedValue(new Error('Sent: over quota'))
    const { parsed, warning } = await deliver(config(), RAW)
    expect(parsed.subject).toBe('Hi')
    expect(warning).toBe('himalaya: sent copy not saved: Sent: over quota\n')
  })

  it('files into the mailbox --save names, over the account default', async () => {
    listMock.mockResolvedValue(GMAIL)
    const { warning } = await deliver(config(), RAW, 'Drafts')
    expect(warning).toBe('')
    expect(appendMock).toHaveBeenCalledWith('Drafts', Buffer.from(RAW), ['\\Seen'])
    expect(listMock).not.toHaveBeenCalled()
  })

  it('honours --save even when saveCopy is off', async () => {
    // --save is the user asking on this one line, so the account-level
    // switch does not veto it.
    const { warning } = await deliver(config({ saveCopy: false }), RAW, 'Drafts')
    expect(warning).toBe('')
    expect(appendMock).toHaveBeenCalledOnce()
  })

  it('warns when the account cannot be reached at all', async () => {
    vi.spyOn(EmailAccessor.prototype, 'getImap').mockRejectedValue(
      new Error('IMAP login failed for u on h'),
    )
    const { warning } = await deliver(config(), RAW)
    expect(warning).toBe('himalaya: sent copy not saved: IMAP login failed for u on h\n')
  })
})
