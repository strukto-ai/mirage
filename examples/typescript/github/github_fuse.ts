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

import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  GitHubResource,
  Mount,
  MountMode,
  Workspace,
  type GitHubConfig,
} from "@struktoai/mirage-node";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__HERE, "../../../.env.development") });

function buildConfig(): GitHubConfig {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token === "")
    throw new Error("GITHUB_TOKEN env var is required");
  const owner = process.env.GITHUB_OWNER ?? "anthropics";
  const repo = process.env.GITHUB_REPO ?? "anthropic-sdk-typescript";
  const ref = process.env.GITHUB_REF;
  return ref !== undefined
    ? { token, owner, repo, ref }
    : { token, owner, repo };
}

async function main(): Promise<void> {
  const cfg = buildConfig();
  console.log(`Loading ${cfg.owner}/${cfg.repo} …`);
  const resource = await GitHubResource.create(cfg);
  const ws = new Workspace({
    "/github": new Mount(resource, { mode: MountMode.READ, fuse: true }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log(`--- readdir() ${mp} ---`);
    const top = await readdir(mp);
    for (const r of top.slice(0, 10)) console.log(`  ${r}`);

    for (const name of ["README.md", "package.json", "pyproject.toml"]) {
      try {
        const path = `${mp}/${name}`;
        const text = await readFile(path, "utf-8");
        console.log(`\n--- readFile() ${path} (first 200 chars) ---`);
        console.log(text.slice(0, 200));
        break;
      } catch {
        continue;
      }
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`);
    console.log(">>> Open another terminal and run e.g.:");
    console.log(`>>>   ls ${mp}`);
    console.log(`>>>   cat ${mp}/README.md | head`);
    console.log(">>> Press Enter to unmount and exit...");

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await rl.question("");
    rl.close();
  } finally {
    await ws.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
