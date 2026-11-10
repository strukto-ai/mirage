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

// Each unit option of `free`: its power of its base, and whether that base is
// 1000.
export const FREE_UNITS: Readonly<Record<string, readonly [number, boolean]>> = {
  b: [0, false],
  kilo: [1, true],
  mega: [2, true],
  giga: [3, true],
  tera: [4, true],
  peta: [5, true],
  k: [1, false],
  m: [2, false],
  g: [3, false],
  tebi: [4, false],
  pebi: [5, false],
}

// `free`'s width for its row labels, its first column and the others.
export const FREE_LABEL_WIDTH = 7
export const FREE_FIRST_WIDTH = 13
export const FREE_WIDTH = 12

// `free -h`'s unit letters, and the most characters a figure may take.
export const HUMAN_UNITS = 'KMGTPE'
export const HUMAN_DIGITS = 3

// What `free` prints for a figure the machine has no such thing for.
export const NO_FIGURE = '-'

// Where `lscpu` starts its values, and the rows too wide to sit beside another
// machine's, which `lscpu --machine` still prints.
export const LSCPU_VALUE_COLUMN = 41
export const LSCPU_WIDE_ROWS: readonly string[] = ['Flags:', 'Vulnerability ']

// The rests between `free -c` passes without `-s`, and top's.
export const FREE_DELAY_SECONDS = 1
export const TOP_DELAY_SECONDS = 3

// `top`'s line width when nothing says how wide.
export const TOP_WIDTH = 80

// `top -E`: each scale's memory unit, in bytes.
export const TOP_SCALES: Readonly<Record<string, readonly [string, number]>> = {
  k: ['KiB', 1024],
  m: ['MiB', 1024 ** 2],
  g: ['GiB', 1024 ** 3],
  t: ['TiB', 1024 ** 4],
  p: ['PiB', 1024 ** 5],
  e: ['EiB', 1024 ** 6],
}

// `top -o`: each field it sorts by, and whether the largest goes first.
export const TOP_SORT_FIELDS: Readonly<Record<string, boolean>> = {
  PID: false,
  USER: false,
  VIRT: true,
  RES: true,
  '%CPU': true,
  '%MEM': true,
  'TIME+': true,
  COMMAND: false,
}

// `uptime -p`'s parts, largest first: each name and its seconds.
export const PRETTY_UNITS: readonly (readonly [string, number])[] = [
  ['decade', 3650 * 86400],
  ['year', 365 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
]
