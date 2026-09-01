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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { z } from '@struktoai/mirage-core/resource/secrets'
import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import { registerSecrets } from '@struktoai/mirage-core/secrets/registry'
import type { EnvEntries, ResolvedSecret } from '@struktoai/mirage-core/secrets/types'

const CounterConfig = z.strictObject({})
type CounterConfig = z.infer<typeof CounterConfig>

const DeadConfig = z.strictObject({})
type DeadConfig = z.infer<typeof DeadConfig>

async function fetchDead(_config: DeadConfig, _ref: string): Promise<ResolvedSecret> {
  throw new SecretsError('vault sealed')
}

/**
 * The env plane a secrets target declares, plus its cleanup.
 *
 * Registers the counting fake (fresh per-ref counters per open, so the
 * counts inside fetched values are deterministic within one target run
 * and prove how many times each secret was fetched), materializes the
 * dotenv file the `dotenv` entry points at (its path exists only at run
 * time, which is why the block is built here and not spelled in
 * targets.json), and seeds the process variable the `env` entry reads.
 * `kind` "dead" is a separate target on purpose: a whole-env command
 * fetches every unfetched name, so one dead source would fail the
 * healthy target's `env` case. `kind` "gated" is one pointer on a
 * source that always fails, behind the target's denying profile: only
 * a dead source can prove a refused command never fetched, and it
 * needs its own target so the deny and the extra pending name cannot
 * leak into the other batteries. `kind` "implicit" manages the names
 * read with no `$NAME` in the text (`HOME` for a tilde and a bare
 * `cd`, `OLDPWD` for `cd -`, `CDPATH` for a relative `cd`, `OPTIND`
 * and `OPTERR` for `getopts`) plus `ARITH_BOUND` for the arithmetic
 * value chase
 * and the `ARITH_HOP`/`ARITH_END` pair, whose first value names the
 * second so only a replan after the fetch can reach it;
 * they need their own target because any whole-env case would fetch
 * them first and each case would then prove nothing, and the
 * directory values name the target's mount root so `cd` lands on a
 * real directory. The dotenv file carries a `${...}` value on purpose:
 * values are read verbatim in both languages, and interpolating hosts
 * would disagree here.
 */
export function buildSecretsEnv(kind: string): {
  env: EnvEntries
  cleanup: () => Promise<void>
} {
  if (kind === 'dead') {
    registerSecrets('dead', DeadConfig, fetchDead)
    return {
      env: { DEAD: { from: 'dead', ref: 'x' }, DEAD2: { from: 'dead', ref: 'y' } },
      cleanup: async () => undefined,
    }
  }
  if (kind === 'gated') {
    registerSecrets('gated', DeadConfig, fetchDead)
    return {
      env: { GATED: { from: 'gated', ref: 'z' } },
      cleanup: async () => undefined,
    }
  }
  if (kind === 'implicit') {
    process.env['MIRAGE_INTEG_HOME_DIR'] = '/data'
    process.env['MIRAGE_INTEG_OLDPWD_DIR'] = '/data'
    process.env['MIRAGE_INTEG_CDPATH_DIR'] = '/data'
    process.env['MIRAGE_INTEG_OPTIND_START'] = '1'
    process.env['MIRAGE_INTEG_OPTERR'] = '0'
    process.env['MIRAGE_INTEG_ARITH_BOUND'] = '7'
    process.env['MIRAGE_INTEG_ARITH_HOP'] = 'ARITH_END'
    process.env['MIRAGE_INTEG_ARITH_END'] = '9'
    return {
      env: {
        HOME: { from: 'env', key: 'MIRAGE_INTEG_HOME_DIR' },
        OLDPWD: { from: 'env', key: 'MIRAGE_INTEG_OLDPWD_DIR' },
        CDPATH: { from: 'env', key: 'MIRAGE_INTEG_CDPATH_DIR' },
        OPTIND: { from: 'env', key: 'MIRAGE_INTEG_OPTIND_START' },
        OPTERR: { from: 'env', key: 'MIRAGE_INTEG_OPTERR' },
        ARITH_BOUND: { from: 'env', key: 'MIRAGE_INTEG_ARITH_BOUND' },
        ARITH_HOP: { from: 'env', key: 'MIRAGE_INTEG_ARITH_HOP' },
        ARITH_END: { from: 'env', key: 'MIRAGE_INTEG_ARITH_END' },
      },
      cleanup: async () => undefined,
    }
  }
  const counts = new Map<string, number>()
  const fetchCounting = async (_config: CounterConfig, ref: string): Promise<ResolvedSecret> => {
    const n = (counts.get(ref) ?? 0) + 1
    counts.set(ref, n)
    return {
      fields: {
        token: `tok${String(n)}`,
        user: `u${String(n)}`,
        pass: `p${String(n)}`,
      },
    }
  }
  registerSecrets('counter', CounterConfig, fetchCounting)
  process.env.MIRAGE_INTEG_ENV_SECRET = 'from-process-env'
  const dir = mkdtempSync(join(tmpdir(), 'mirage-integ-secrets-'))
  const dotfile = join(dir, 'secrets.env')
  writeFileSync(dotfile, 'DOTFILE_SECRET=from-dotenv\nDOTFILE_TEMPLATE=${DOTFILE_SECRET}-lit\n')
  const cleanup = async (): Promise<void> => {
    rmSync(dir, { recursive: true, force: true })
  }
  const env: EnvEntries = {
    APP_NAME: 'integ',
    EDITOR: { value: 'vi', readonly: true },
    TOKEN: { from: 'counter', ref: 'tok', key: 'token' },
    DB_USER: { from: 'counter', ref: 'db', key: 'user' },
    DB_PASS: { from: 'counter', ref: 'db', key: 'pass' },
    EAGER_PAIR: { from: 'counter', ref: 'pair', key: 'token', fetch: 'eager' },
    LAZY_PAIR: { from: 'counter', ref: 'pair', key: 'user' },
    FROM_ENV: { from: 'env', key: 'MIRAGE_INTEG_ENV_SECRET' },
    FROM_DOTFILE: { from: 'dotenv', ref: dotfile, key: 'DOTFILE_SECRET' },
    FROM_DOTFILE_LITERAL: { from: 'dotenv', ref: dotfile, key: 'DOTFILE_TEMPLATE' },
    FN_TOKEN: { from: 'counter', ref: 'fn', key: 'token' },
    IND_TOKEN: { from: 'counter', ref: 'ind', key: 'token' },
    ALIAS_TOKEN: { from: 'counter', ref: 'alias', key: 'token' },
    CLEAN_TOKEN: { from: 'counter', ref: 'clean', key: 'token' },
    REDEF_TOKEN: { from: 'counter', ref: 'redef', key: 'token' },
    APPEND_TOKEN: { from: 'counter', ref: 'app', key: 'token' },
  }
  return { env, cleanup }
}
