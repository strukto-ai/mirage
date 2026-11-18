import { expect, test } from 'vitest'
import { renderMime } from './mime.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const headers = 'Subject: Sample\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n'

test('plain text JSON handles a decoded UTF-8 BOM like the Node parser', () => {
  const raw = encoder.encode(headers + '\uFEFFbody')
  const result = JSON.parse(decoder.decode(renderMime(raw, 'json'))) as {
    parts: { body: unknown }[]
  }
  expect(result.parts[0]?.body).toEqual({ Text: 'body' })
})

test('the default view preserves Node whitespace and size formatting', () => {
  const raw = encoder.encode(headers + 'a'.repeat(1149) + '\uFEFF')
  const result = decoder.decode(renderMime(raw, 'read'))
  expect(result).toContain('[1] text/plain (1.13 KiB)')
  expect(result.endsWith('a'.repeat(1149) + '\n')).toBe(true)
})
