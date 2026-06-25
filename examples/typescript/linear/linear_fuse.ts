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
  LinearResource,
  Mount,
  MountMode,
  Workspace,
  type LinearConfig,
} from "@struktoai/mirage-node";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__HERE, "../../../.env.development") });

function buildConfig(): LinearConfig {
  const apiKey = process.env.LINEAR_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("LINEAR_API_KEY env var is required");
  }
  return { apiKey };
}

async function main(): Promise<void> {
  const resource = new LinearResource(buildConfig());
  const ws = new Workspace({
    "/linear": new Mount(resource, { mode: MountMode.READ, fuse: true }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log("--- readdir() /linear ---");
    for (const r of await readdir(mp)) console.log(`  ${r}`);

    console.log("\n--- readdir() /linear/teams ---");
    const teams = await readdir(`${mp}/teams`);
    for (const t of teams.slice(0, 5)) console.log(`  ${t}`);

    if (teams.length === 0) {
      console.log("  (no teams)");
      return;
    }
    const t0 = teams[0]!;
    const teamPath = `${mp}/teams/${t0}`;

    console.log(`\n--- readFile() ${t0}/team.json ---`);
    const teamBytes = await readFile(`${teamPath}/team.json`, "utf-8");
    console.log(`  ${teamBytes.trim().slice(0, 250)}`);

    console.log(`\n--- readdir() ${t0}/issues ---`);
    const issues = await readdir(`${teamPath}/issues`);
    for (const i of issues.slice(0, 5)) console.log(`  ${i}`);

    if (issues.length > 0) {
      const i0 = issues[0]!;
      const issuePath = `${teamPath}/issues/${i0}`;

      console.log(`\n--- readFile() ${i0}/issue.json ---`);
      const issueBytes = await readFile(`${issuePath}/issue.json`, "utf-8");
      try {
        const data = JSON.parse(issueBytes) as {
          issue_key?: string;
          title?: string;
          state_name?: string;
        };
        console.log(
          `  ${data.issue_key ?? "?"}: ${data.title ?? ""} [${data.state_name ?? ""}]`,
        );
      } catch {
        console.log(`  (raw: ${issueBytes.slice(0, 100)})`);
      }
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`);
    console.log(">>> Open another terminal and run:");
    console.log(`>>>   ls ${mp}/teams/`);
    console.log(`>>>   cat ${mp}/teams/<team>/issues/<issue>/issue.json`);
    console.log(`>>>   grep -r bug ${mp}/teams/`);
    console.log(">>> Press Enter to unmount and exit...");

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await rl.question("");
    rl.close();

    const records = ws.records;
    const total = records.reduce((acc, r) => acc + (r.bytes ?? 0), 0);
    console.log(
      `\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`,
    );
  } finally {
    await ws.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
