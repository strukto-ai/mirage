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

import type { CompiledSpec } from './compile.ts'

export interface OldStyleArgv {
  // The rewritten words.
  argv: string[]
  // For each rewritten word, the position it came from in the caller's
  // argv. Synthesized flag tokens all carry the cluster's own position,
  // so a word kind written back through this table can only land on a
  // real word.
  origins: number[]
  // The word read as a letter cluster, when the line had one. The parser
  // marks its slot TEXT so the word survives path classification
  // verbatim and the dispatch-time scan reads the same letters the
  // hint-time scan did.
  cluster: string | null
  // The cluster letter whose argument ran off the end of the line.
  needsValue: string | null
}

/**
 * Rewrite GNU tar's old option style into ordinary dashed flags.
 *
 * tar's first word, when it carries no leading dash, is a cluster of
 * option letters whose arguments follow it as separate words in letter
 * order: `tar xzCf dir a.tgz` is `-x -z -C dir -f a.tgz`. Only the first
 * word reads this way, which is GNU's own rule (`tar -v czf a.tgz f` is
 * a usage error), so a line that already starts with a dash is returned
 * untouched.
 *
 * Per letter, not one `-xzCf` token, because the getopt cluster rules
 * cannot express what a tar cluster can: it may hold several
 * argument-taking letters (`tar cvfb a.tar 20 f`) and it may continue
 * past one (`tar cfz a.tgz f` gzips, where getopt would read `z` as f's
 * value). An argument is taken verbatim, dash or not, the way GNU does:
 * `tar xzf -C ex` looks for an archive literally named `-C`.
 *
 * An undeclared letter becomes an undeclared flag token and is refused
 * by the parser's own scan, so this only reports the one error getopt
 * cannot see: a value letter with nothing left to consume. Pair options
 * are not expanded here; no tool spells old style and a two-token option
 * at once. Mirrors Python's `expand_old_style`.
 */
export function expandOldStyle(cs: CompiledSpec, argv: string[]): OldStyleArgv {
  const first = argv[0]
  if (first === undefined || first.startsWith('-')) {
    return { argv: [...argv], origins: argv.map((_, idx) => idx), cluster: null, needsValue: null }
  }
  const out: string[] = []
  const origins: number[] = []
  let nxt = 1
  for (const ch of first) {
    out.push(`-${ch}`)
    origins.push(0)
    if (!cs.valueSpellings.includes(`-${ch}`)) continue
    const value = argv[nxt]
    if (value === undefined) {
      return { argv: out, origins, cluster: first, needsValue: ch }
    }
    out.push(value)
    origins.push(nxt)
    nxt += 1
  }
  for (let idx = nxt; idx < argv.length; idx++) {
    const word = argv[idx]
    if (word === undefined) continue
    out.push(word)
    origins.push(idx)
  }
  return { argv: out, origins, cluster: first, needsValue: null }
}
