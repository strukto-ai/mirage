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

import type { SearchResult } from '../../vfs/types.ts'
import { describe, expect, it } from 'vitest'
import { formatGrepResults, type GmailSearchRow } from './search.ts'

const LABEL = 'INBOX'

const EMOJI = '\u{1F600}'

function row(bodyText: string): GmailSearchRow {
  return {
    id: 'm1',
    subject: 'note',
    snippet: 'fallback snippet',
    sender: 'a@b.c',
    date: '2026-08-19',
    label: 'INBOX',
    bodyText,
  }
}

/** The excerpt is everything after the `<path>:[<sender>] ` header. */
function excerptOf(lines: SearchResult[]): string {
  const line = lines[0]?.[1] ?? ''
  return line.slice(line.indexOf('] ') + 2)
}

/**
 * Re-encode through UTF-8, which is what a lone surrogate does not survive.
 *
 * A slice that lands inside a surrogate pair leaves a half that is still a
 * legal `String` value, so `toContain('�')` on the raw excerpt sees
 * nothing; the replacement character only appears once the bytes are written.
 */
function roundTrip(text: string): string {
  return new TextDecoder('utf-8').decode(new TextEncoder().encode(text))
}

describe('formatGrepResults excerpts', () => {
  it('measures the no-match budget in code points, matching python', () => {
    // Gmail matched the message server-side on something the literal scan
    // does not find, so the excerpt falls back to the head of the body.
    // 200 emoji are 200 code points and 400 UTF-16 units: python returns all
    // of them, and measuring in units returned 117 plus a split 118th pair.
    const body = EMOJI.repeat(200)
    const excerpt = excerptOf(formatGrepResults([row(body)], LABEL, '/gmail', 'zzz'))
    expect(excerpt).toBe(`note ${body}`)
    expect(Array.from(excerpt)).toHaveLength(205)
    expect(roundTrip(excerpt)).not.toContain('�')
  })

  it('windows around the match on code-point boundaries', () => {
    const pad = EMOJI.repeat(200)
    const excerpt = excerptOf(
      formatGrepResults([row(`${pad} needle ${pad}`)], LABEL, '/gmail', 'needle'),
    )
    // `note ` + 200 emoji + ` needle ` + 200 emoji, windowed 120 code points
    // either side of the hit at index 206 and clipped to the body's end.
    expect(excerpt).toBe(`...${EMOJI.repeat(119)} needle ${EMOJI.repeat(119)}...`)
    expect(roundTrip(excerpt)).not.toContain('�')
  })

  it('leaves an ascii excerpt exactly where python leaves it', () => {
    const body = `${'a'.repeat(300)} needle ${'b'.repeat(300)}`
    const excerpt = excerptOf(formatGrepResults([row(body)], LABEL, '/gmail', 'needle'))
    expect(excerpt).toBe(`...${'a'.repeat(119)} needle ${'b'.repeat(119)}...`)
  })

  it('falls back to the snippet when the pattern is empty', () => {
    const lines = formatGrepResults([row('body')], LABEL, '/gmail')
    expect(lines.map(([, text]) => text)).toEqual([
      '/gmail/INBOX/2026-08-19/note__m1.gmail.json:[a@b.c] fallback snippet',
    ])
  })
})
