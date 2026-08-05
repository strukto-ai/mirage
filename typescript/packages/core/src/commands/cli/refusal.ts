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

import { USAGE_EXIT } from './constants.ts'
import { UsageStyle } from './types.ts'

export const ARGPARSE_EXIT = 2
const LONG_PREFIX = '--'

const ENC = new TextEncoder()

/**
 * git's refusal for an option it does not know.
 *
 * Two nouns and no program name, pinned against git 2.50.1: a long option is an
 * "option" and a short one is a "switch", both named without their dashes and
 * quoted with a backquote-apostrophe pair. git follows this with the verb's
 * usage block, which is omitted the same way GNU's is elsewhere in the spec
 * machinery.
 *
 * @param token the offending token ('--nosuch') or cluster character ('Z'), as
 *   the flat parser reports it
 */
export function gitUnknownOption(token: string): Uint8Array {
  const noun = token.startsWith(LONG_PREFIX) ? 'option' : 'switch'
  return ENC.encode(`error: unknown ${noun} \`${token.replace(/^-+/, '')}'\n`)
}

/**
 * The message and exit code a leaf answers a bad option with.
 *
 * A leaf usage error exits 2 under argparse's style regardless of the GNU
 * USAGE_EXIT table, because an installed CLI name is never a GNU tool with its
 * own pinned exit. git exits 129 for the same mistake, which is neither that
 * nor its own 128 for a fatal.
 *
 * @param style the dialect the CLI's root declares
 * @param argparseMessage the message the spec machinery built, used as-is for
 *   argparse and for anything git words the same
 * @param invalidOptions the offending tokens the parser reported, read when the
 *   style rewrites the message
 */
export function leafRefusal(
  style: UsageStyle,
  argparseMessage: Uint8Array,
  invalidOptions: readonly string[],
): [Uint8Array, number] {
  if (style !== UsageStyle.GIT) return [argparseMessage, ARGPARSE_EXIT]
  const first = invalidOptions[0]
  if (first !== undefined) return [gitUnknownOption(first), USAGE_EXIT]
  return [argparseMessage, USAGE_EXIT]
}
