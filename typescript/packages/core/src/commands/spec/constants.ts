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

export const AMBIGUOUS_NAMES: Readonly<Record<string, string>> = Object.freeze({
  l: 'args_l',
  O: 'args_O',
  I: 'args_I',
  '1': 'args_1',
})

// Numeric shorthand token like `-5` (head/tail count), never a flag
// cluster or a path.
/**
 * Map a flag name to its dispatcher kwarg name.
 *
 * Mirrors Python's `flag_kwarg_name`. The dispatcher spells flags without
 * their dashes and with dashes turned into underscores, so this is the one
 * place that translation lives.
 */
export function flagKwargName(flag: string): string {
  const clean = flag.replace(/^-+/, '').replaceAll('-', '_')
  return AMBIGUOUS_NAMES[clean] ?? clean
}

export const NUMERIC_SHORT = /^-\d+$/

// Value shape accepted by an int-typed option: optional sign plus digits,
// the portable core of Python int() and argparse (no whitespace, no
// underscores, so both languages accept exactly the same strings).
export const INT_VALUE = /^[+-]?\d+$/
export const FLOAT_VALUE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

// GNU usage-error exit codes, pinned against debian coreutils/grep/diffutils
// (plus ripgrep and jq upstream docs). Everything else exits 1.
// Commands whose `Try '--help'` hint line is prefixed with the command
// name (GNU diffutils style: `diff: Try 'diff --help' ...`).
export const USAGE_HINT_PREFIX: ReadonlySet<string> = new Set(['diff', 'cmp'])

// An old-style cluster letter left without its argument exits 2, not
// USAGE_EXIT's 64: tar reads the cluster itself and raises its own fatal
// error, while 64 (EX_USAGE) is what argp returns for a letter it does
// not know. Pinned on GNU tar 1.35: `tar xzf` is 2, `tar -Q` is 64.
export const OLD_OPTION_EXIT = 2

export const USAGE_EXIT: Readonly<Record<string, number>> = Object.freeze({
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
