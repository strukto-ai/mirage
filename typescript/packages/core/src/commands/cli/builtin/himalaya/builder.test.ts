import { expect, it } from 'vitest'
import { build, composeBody, hasPrefix, parseMailboxes, type Source } from './builder.ts'

const DEC = new TextDecoder()

function stable(raw: Uint8Array): string {
  return DEC.decode(raw)
    .replace(/Message-ID: <[^>]*>\r\n/, '')
    .replace(/Date: [^\r]*\r\n/, '')
}

const COMPOSE = {
  to: [],
  cc: [],
  bcc: [],
  subject: null,
  body: '',
  signature: null,
  attachments: [],
}
const ORIGINAL = {
  subject: 'Quarterly numbers',
  from: { name: 'Alice', email: 'alice@example.com' },
  message_id: '<m1@example.com>',
  references: ['<m0@example.com>'],
  reply_to: [],
  body_text: 'line one\nline two',
} as unknown as Source['message']

it('keeps display names apart from their addresses', () => {
  expect(parseMailboxes('"Doe, J." <j@x>, b@x')).toEqual([
    ['Doe, J.', 'j@x'],
    [null, 'b@x'],
  ])
  expect(() => parseMailboxes('')).toThrow('Could not parse address ``')
})

it('keeps the colon when it reads a prefix', () => {
  expect(hasPrefix('Re: hello', 'Re: ')).toBe(true)
  expect(hasPrefix('Ready to ship', 'Re: ')).toBe(false)
})

it('lays out the quote and the signature', () => {
  expect(composeBody('mine\n', 'a\n> b\n', '', '', 'top')).toBe('mine\n\n> a\n>> b')
  expect(composeBody('mine', 'a', 'On Monday:', '', 'bottom')).toBe('On Monday:\n> a\n\nmine')
  expect(composeBody('mine', 'a', '', '', 'none')).toBe('mine')
  expect(composeBody('', 'a', '', 'sig\n', 'top')).toBe('> a\n\n-- \nsig')
})

it("lays headers out in upstream's order", () => {
  const raw = build({
    ...COMPOSE,
    sender: 'me@x',
    to: ['a@x', 'B <b@x>'],
    cc: ['c@x'],
    subject: 'Hi',
    body: 'hello',
  })
  expect(stable(raw)).toBe(
    'From: <me@x>\r\nTo: <a@x>, "B" <b@x>\r\nCc: <c@x>\r\nSubject: Hi\r\nMIME-Version: 1.0\r\n' +
      'Content-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\nhello',
  )
})

it('writes a message id and a date', () => {
  const text = DEC.decode(build({ ...COMPOSE, sender: 'me@x', body: 'x' }))
  expect(text).toMatch(/Message-ID: <[0-9a-f.]+@localhost>\r\n/)
  expect(text).toMatch(/Date: \w{3}, \d{1,2} \w{3} \d{4} /)
})

it('uses quoted-printable for a trailing-space line and an encoded word for non-ASCII', () => {
  const signed = stable(build({ ...COMPOSE, sender: 'me@x', body: 'hello', signature: 'sig' }))
  expect(signed).toContain('Content-Transfer-Encoding: quoted-printable')
  expect(signed.endsWith('hello\r\n\r\n--=20\r\nsig')).toBe(true)
  expect(stable(build({ ...COMPOSE, sender: 'me@x', subject: 'Résumé', body: 'x' }))).toContain(
    'Subject: =?utf-8?B?UsOpc3Vtw6k=?=\r\n',
  )
})

it('threads a reply and quotes its source', () => {
  const text = stable(
    build(
      { ...COMPOSE, sender: 'me@x', body: 'ack' },
      { message: ORIGINAL, mode: 'reply', postingStyle: 'top', quoteHeadline: '' },
    ),
  )
  expect(text).toContain('To: "Alice" <alice@example.com>\r\n')
  expect(text).toContain('In-Reply-To: <m1@example.com>\r\n')
  expect(text).toContain('References: <m0@example.com> <m1@example.com>\r\n')
  expect(text).toContain('Subject: Re: Quarterly numbers\r\n')
  expect(text.endsWith('ack\r\n\r\n> line one\r\n> line two')).toBe(true)
})

it('builds multipart/mixed for attachments', () => {
  const text = stable(
    build({
      ...COMPOSE,
      sender: 'me@x',
      to: ['a@x'],
      body: 'see',
      attachments: [
        {
          filename: 'note.txt',
          contentType: 'text/plain',
          data: new TextEncoder().encode('note\n'),
        },
        {
          filename: 'a.bin',
          contentType: 'application/octet-stream',
          data: new Uint8Array([0, 255]),
        },
      ],
    }),
  )
  const boundary = /boundary="([^"]+)"/.exec(text)?.[1] ?? ''
  expect(text).toContain('Content-Disposition: attachment; filename="note.txt"')
  expect(text).toContain('Content-Transfer-Encoding: base64\r\n\r\nAP8=\r\n')
  expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true)
})

it('keeps a decoded name from breaking a header line', () => {
  const text = DEC.decode(
    build({ ...COMPOSE, sender: 'me@x', to: ['=?UTF-8?B?QQ0KQmNjOiB4QHk=?= <a@b>'], body: 'x' }),
  )
  expect(text).toContain('To: "ABcc: x@y" <a@b>\r\n')
})
