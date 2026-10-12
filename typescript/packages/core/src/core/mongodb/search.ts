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

import type { MongoDBAccessor } from '../../accessor/mongodb.ts'
import type { PathSpec } from '../../types.ts'
import { recordQueries } from '../../utils/record_search.ts'
import { iterDocuments } from './client.ts'
import { entityGuard } from './readdir.ts'
import { detectScope } from './scope.ts'
import { applyElision, elisionPaths, stringifyDoc } from './stream.ts'
import { PRIMARY_KEY } from './types.ts'

// The words a document's line holds whatever its keys and strings say:
// Extended JSON's type wrappers and their keys, the JSON literals, a double's
// NaN and Infinity and a date's Z. Mirrors Python's `RECORD_KEYS`.
export const RECORD_KEYS: ReadonlySet<string> = new Set([
  'oid',
  'date',
  'numberlong',
  'numberint',
  'numberdouble',
  'numberdecimal',
  'binary',
  'base64',
  'subtype',
  'uuid',
  'regularexpression',
  'pattern',
  'options',
  'code',
  'scope',
  'symbol',
  'timestamp',
  't',
  'i',
  'minkey',
  'maxkey',
  'dbpointer',
  'ref',
  'id',
  'undefined',
  'true',
  'false',
  'null',
  'nan',
  'infinity',
  'z',
])
// Value types whose line spells letters no key or string of the document holds
// (a binary's base64, a regex's pattern, code, a symbol), so a document holding
// one is always a candidate.
const OPAQUE = ['binData', 'regex', 'javascript', 'javascriptWithScope', 'symbol', 'dbPointer']
// How deep the walk looks into nested documents and arrays; a document nested
// deeper is a candidate.
export const DEPTH = 8
// A line spells a character outside ASCII as a `\uXXXX` escape on one host,
// whose letters a text starting with `u` or a hex letter can begin inside.
const ESCAPE_STARTS = new Set('abcdefu')

type Expr = Record<string, unknown>

function bind(test: Expr, value: string): Expr {
  return { $let: { vars: { tested: value }, in: test } }
}

// One level of the walk: test each key and string of the values at `level`,
// and gather what nests inside them for the next. Mirrors Python's `_step`.
function step(level: string, test: Expr): Expr {
  return {
    $reduce: {
      input: `$$${level}.next`,
      initialValue: { hit: `$$${level}.hit`, next: [] },
      in: {
        $switch: {
          branches: [
            {
              case: { $eq: [{ $type: '$$this' }, 'string'] },
              then: { hit: { $or: ['$$value.hit', bind(test, '$$this')] }, next: '$$value.next' },
            },
            {
              case: { $eq: [{ $type: '$$this' }, 'object'] },
              then: {
                $let: {
                  vars: { pairs: { $objectToArray: '$$this' } },
                  in: {
                    hit: {
                      $or: [
                        '$$value.hit',
                        {
                          $anyElementTrue: [
                            { $map: { input: '$$pairs', as: 'pair', in: bind(test, '$$pair.k') } },
                          ],
                        },
                      ],
                    },
                    next: { $concatArrays: ['$$value.next', '$$pairs.v'] },
                  },
                },
              },
            },
            {
              case: { $eq: [{ $type: '$$this' }, 'array'] },
              then: { hit: '$$value.hit', next: { $concatArrays: ['$$value.next', '$$this'] } },
            },
            {
              case: { $in: [{ $type: '$$this' }, OPAQUE] },
              then: { hit: true, next: '$$value.next' },
            },
          ],
          default: '$$value',
        },
      },
    },
  }
}

/**
 * A find filter for the documents whose line may hold one of `queries`: a key
 * or a string at any depth holds it in any case, a string holds a character
 * the line may spell as an escape, or a value is one the walk cannot see into.
 * Mirrors Python's `holds_filter`.
 */
export function holdsFilter(queries: readonly string[]): Expr {
  const words: Expr = { $regexMatch: { input: '$$tested', regex: queries.join('|'), options: 'i' } }
  const test: Expr = queries.some((query) => ESCAPE_STARTS.has((query[0] ?? '').toLowerCase()))
    ? { $or: [words, { $regexMatch: { input: '$$tested', regex: '[^\\x00-\\x7f]' } }] }
    : words
  let body: Expr = {
    $or: [`$$s${String(DEPTH)}.hit`, { $gt: [{ $size: `$$s${String(DEPTH)}.next` }, 0] }],
  }
  for (let depth = DEPTH - 1; depth >= 0; depth -= 1) {
    body = {
      $let: { vars: { [`s${String(depth + 1)}`]: step(`s${String(depth)}`, test) }, in: body },
    }
  }
  return { $expr: { $let: { vars: { s0: { hit: false, next: ['$$ROOT'] } }, in: body } } }
}

/**
 * The lines of a collection's or view's documents.jsonl that may hold `text`,
 * streamed in the `_id` order a plain read takes. MongoDB walks each
 * document's keys and strings on the server (`holdsFilter`), so only the
 * documents that may match are sent; grep matches each line itself. `text`
 * goes through `recordQueries` for the words of Extended JSON's wrappers and
 * for escapes. null for any other file and for a text that could match outside
 * a key or a string. Mirrors Python's `lines_containing`.
 */
export async function linesContaining(
  accessor: MongoDBAccessor,
  path: PathSpec,
  text: string,
): Promise<AsyncIterable<Uint8Array> | null> {
  const match = detectScope(path)
  if (match.kind !== 'documents') return null
  const queries = recordQueries(text, RECORD_KEYS, false)
  if (queries === null) return null
  await entityGuard(accessor, match, path.virtual)
  return matching(accessor, match.slots.database ?? '', match.slots.name ?? '', queries)
}

async function* matching(
  accessor: MongoDBAccessor,
  database: string,
  name: string,
  queries: readonly string[],
): AsyncIterableIterator<Uint8Array> {
  const elide = elisionPaths(accessor, database, name)
  const encoder = new TextEncoder()
  for await (const doc of iterDocuments(accessor, database, name, {
    filter: holdsFilter(queries),
    sort: { [PRIMARY_KEY]: 1 },
    batchSize: 100,
  })) {
    const final = elide.size > 0 ? applyElision(doc, elide) : doc
    yield encoder.encode(`${stringifyDoc(final)}\n`)
  }
}
