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

// GNU usage-error exit codes, pinned against debian coreutils/grep/diffutils
// (plus ripgrep and jq upstream docs). Everything else exits 1.
const USAGE_EXIT: Readonly<Record<string, number>> = Object.freeze({
  grep: 2,
  egrep: 2,
  fgrep: 2,
  zgrep: 2,
  rg: 2,
  ls: 2,
  sort: 2,
  diff: 2,
  cmp: 2,
  awk: 2,
  jq: 2,
  tar: 64,
})

/** GNU usage-error exit code for a command. */
export function usageExitCode(cmdName: string): number {
  return USAGE_EXIT[cmdName] ?? 1
}

/**
 * GNU-shaped error for an option the spec does not declare.
 *
 * Shapes pinned against real GNU: long options report the full token
 * (`cat: unrecognized option '--bogus=x'`), short options report the
 * offending character (`cat: invalid option -- 'Y'`), and find uses its
 * predicate wording with backquote quoting. GNU's per-tool usage dumps
 * are deliberately omitted; the `--help` hint line is kept because every
 * registered command serves `--help`.
 */
export function unknownOptionError(cmdName: string, token: string): [Uint8Array, number] {
  if (cmdName === 'find') {
    const dashed = token.startsWith('-') ? token : `-${token}`
    return [
      new TextEncoder().encode(`find: unknown predicate \`${dashed}'\n`),
      usageExitCode(cmdName),
    ]
  }
  const line = token.startsWith('--')
    ? `${cmdName}: unrecognized option '${token}'\n`
    : `${cmdName}: invalid option -- '${token}'\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
}

/** GNU-shaped error for a declared value flag with no argument left. */
export function missingValueError(cmdName: string, token: string): [Uint8Array, number] {
  const line = token.startsWith('--')
    ? `${cmdName}: option '${token}' requires an argument\n`
    : `${cmdName}: option requires an argument -- '${token}'\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
}
