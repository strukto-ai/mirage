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

// Marshals as gh 2.85.0's types do under Go 1.25.5's encoding/json
// (MIT and BSD-3-Clause; see licenses/third_party/gh.txt and go.txt).

/**
 * The Go type gh decodes a field into, which is what decides how it prints.
 *
 * A string prints `""` for null, a number 0 and a bool false; `time` is a
 * non-pointer `time.Time`, whose zero is the year-one timestamp; `raw` is a
 * pointer (or a nullable time) and stays null. A struct prints every one of
 * its fields in its own order, zero-filled where the query asked for fewer
 * (a user's `databaseId` is always there, as 0), and prints null only when it
 * is a pointer. A list prints null when the answer carried none. Each struct
 * field may read a differently spelled key from the answer: an untagged Go
 * field prints under its own name.
 *
 * Three of gh's types marshal themselves. `author` is its `Author`, which
 * prints a user as `{id, is_bot, login, name}` and an actor with no id (a
 * bot, whose login the query reads without one) as `app/<login>`.
 * `reactions` is its `ReactionGroups`, which drops every group nobody
 * reacted with and prints `[]` rather than null. `owner` is its `Owner`,
 * whose id and name are `omitempty`. `orNull` is a pointer to any of them.
 */
export type Shape =
  | 'string'
  | 'int'
  | 'bool'
  | 'time'
  | 'raw'
  | 'author'
  | 'reactions'
  | 'owner'
  | {
      readonly fields: readonly (readonly [string, Shape, string?])[]
      readonly nullable: boolean
    }
  | { readonly list: Shape }
  | { readonly orNull: Shape }

export const ZERO_TIME = '0001-01-01T00:00:00Z'

export function struct(...fields: (readonly [string, Shape, string?])[]): Shape {
  return { fields, nullable: false }
}

export function pointer(...fields: (readonly [string, Shape, string?])[]): Shape {
  return { fields, nullable: true }
}

export function list(shape: Shape): Shape {
  return { list: shape }
}

export function orNull(shape: Shape): Shape {
  return { orNull: shape }
}

const REACTION = struct(['content', 'string'], ['users', struct(['totalCount', 'int'])])

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** gh's `Author.MarshalJSON`: a bot is the one with no id. */
function author(value: unknown): Record<string, unknown> {
  const row = record(value)
  const id = text(row.id)
  if (id === '') return { is_bot: true, login: `app/${text(row.login)}` }
  return { id, is_bot: false, login: text(row.login), name: text(row.name) }
}

/** gh's `ReactionGroups.MarshalJSON`: only the groups someone reacted with. */
function reactions(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((group) => {
      const count = record(record(group).users).totalCount
      return typeof count === 'number' && count > 0
    })
    .map((group) => exported(group, REACTION))
}

/** gh's `Owner`, whose id and name are `omitempty`. */
function owner(value: unknown): Record<string, unknown> {
  const row = record(value)
  const out: Record<string, unknown> = {}
  if (text(row.id) !== '') out.id = row.id
  if (text(row.name) !== '') out.name = row.name
  out.login = text(row.login)
  return out
}

/** One value as gh prints it once decoded into `shape`. */
export function exported(value: unknown, shape: Shape): unknown {
  if (shape === 'string') return typeof value === 'string' ? value : ''
  if (shape === 'int') return typeof value === 'number' ? value : 0
  if (shape === 'bool') return typeof value === 'boolean' ? value : false
  if (shape === 'time') return typeof value === 'string' ? value : ZERO_TIME
  if (shape === 'raw') return value ?? null
  if (shape === 'author') return author(value)
  if (shape === 'reactions') return reactions(value)
  if (shape === 'owner') return owner(value)
  if ('list' in shape) {
    return Array.isArray(value) ? value.map((item) => exported(item, shape.list)) : null
  }
  if ('orNull' in shape) {
    return value === null || value === undefined ? null : exported(value, shape.orNull)
  }
  if ((value === null || value === undefined) && shape.nullable) return null
  const row = record(value)
  return Object.fromEntries(
    shape.fields.map(([name, inner, source]) => [name, exported(row[source ?? name], inner)]),
  )
}
