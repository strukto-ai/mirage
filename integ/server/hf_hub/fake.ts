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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '../../generated/hf_hub/index.js'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { config, type C } from './config.ts'
import { hfHubRoutes } from './routes.ts'
import { gitOid } from './wire.ts'

/** Every file under `dir`, as paths relative to it, sorted. */
function filesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const rel = prefix === '' ? name : `${prefix}/${name}`
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, rel))
    else out.push(rel)
  }
  return out
}

// The fixture states repositories, their commits and their refs; the FILE
// CONTENT a target mounts is the shared directory tree under integ/fixtures/,
// named by a repo's `sourceDir` and expanded into blob rows here.
//
// It used to be pushed over this fake's own commit endpoint by the adapter,
// writing THROUGH the mount, which a read-only Hub mount refuses and which
// was only possible because the mount carried a write surface it should not
// have had. The one thing that arrangement bought, seeding exercising the
// commit path, is not lost: the `hf upload` and `hf repo-files delete` cases
// drive the same endpoint, so a broken commit still fails the battery.
//
// Each key names its model explicitly because the seeder de-pluralizes a
// fixture key to a model name, and none of these four are named that way.
export const hfHubFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  seedRoots: {
    repos: 'HfRepo',
    commits: 'HfCommit',
    refs: 'HfRef',
    blobs: 'HfBlob',
  },
  // Content is expanded here rather than stated in the fixture because the
  // corpus under integ/fixtures/files/ is shared with every other target:
  // inlining it would make a second copy that drifts, and the bytes have to
  // be real for `wc -c` and a ranged read to mean anything.
  afterSeed: async (db, tenant, _counts, _extras, fixtureRoot) => {
    let seq = 0
    for (const repo of await db.hfRepo.findMany({ where: { tenant } })) {
      if (repo.sourceDir === '') continue
      const key = `${repo.kind}/${repo.namespace}/${repo.name}`
      const head = await db.hfRef.findFirst({ where: { tenant, repo: key, name: 'main' } })
      if (head === null) continue
      const commit = await db.hfCommit.findFirst({ where: { tenant, repo: key, sha: head.sha } })
      const when = commit?.createdAt ?? repo.createdAt
      const root = join(fixtureRoot, repo.sourceDir)
      for (const path of filesUnder(root)) {
        const content = readFileSync(join(root, path))
        await db.hfBlob.create({
          data: {
            tenant,
            repo: key,
            sha: head.sha,
            path,
            content,
            oid: gitOid(content),
            lastCommit: head.sha,
            lastModified: when,
            seq: (seq += 1),
          },
        })
      }
    }
  },
  routes: hfHubRoutes,
}
