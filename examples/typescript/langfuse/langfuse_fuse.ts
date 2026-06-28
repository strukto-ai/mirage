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
  LangfuseResource,
  Mount,
  MountMode,
  Workspace,
  type LangfuseConfig,
} from "@struktoai/mirage-node";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__HERE, "../../../.env.development") });

function buildConfig(): LangfuseConfig {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const host = process.env.LANGFUSE_HOST;
  if (publicKey === undefined || publicKey === "") {
    throw new Error("LANGFUSE_PUBLIC_KEY env var is required");
  }
  if (secretKey === undefined || secretKey === "") {
    throw new Error("LANGFUSE_SECRET_KEY env var is required");
  }
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const cfg: LangfuseConfig = {
    publicKey,
    secretKey,
    defaultTraceLimit: 10,
    defaultFromTimestamp: sevenDaysAgo,
  };
  if (host !== undefined && host !== "") cfg.host = host;
  return cfg;
}

async function main(): Promise<void> {
  const resource = new LangfuseResource(buildConfig());
  const ws = new Workspace({
    "/langfuse": new Mount(resource, { mode: MountMode.READ, fuse: true }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log("--- readdir() /langfuse ---");
    for (const r of await readdir(mp)) console.log(`  ${r}`);

    console.log("\n--- readdir() /langfuse/datasets ---");
    const datasets = await readdir(`${mp}/datasets`);
    for (const d of datasets) console.log(`  ${d}`);

    if (datasets.length > 0) {
      const d0 = datasets[0]!;
      console.log(
        `\n--- readFile() /langfuse/datasets/${d0}/items.jsonl (first line) ---`,
      );
      const bytes = await readFile(`${mp}/datasets/${d0}/items.jsonl`, "utf-8");
      const first = bytes.split("\n").find((l) => l.trim() !== "") ?? "";
      console.log(`  ${first.slice(0, 200)}`);
    }

    console.log("\n--- readdir() /langfuse/prompts ---");
    const prompts = await readdir(`${mp}/prompts`);
    for (const p of prompts.slice(0, 5)) console.log(`  ${p}`);

    if (prompts.length > 0) {
      const p0 = prompts[0]!;
      const versions = await readdir(`${mp}/prompts/${p0}`);
      if (versions.length > 0) {
        const v0 = versions[0]!;
        console.log(`\n--- readFile() /langfuse/prompts/${p0}/${v0} ---`);
        const promptBytes = await readFile(
          `${mp}/prompts/${p0}/${v0}`,
          "utf-8",
        );
        try {
          const doc = JSON.parse(promptBytes) as Record<string, unknown>;
          console.log(
            `  ${String(doc.name ?? "?")} v${String(doc.version ?? "?")}`,
          );
        } catch {
          console.log(`  (raw: ${promptBytes.slice(0, 100)})`);
        }
      }
    }

    console.log("\n" + "=".repeat(72));
    console.log(`>>> FUSE mounted at:  ${mp}`);
    console.log(`>>> Langfuse root:    ${mp}`);
    console.log("=".repeat(72));
    console.log("\n>>> Open in Finder:");
    console.log(`>>>   open ${mp}`);
    console.log(">>> Or in another terminal:");
    console.log(`>>>   ls ${mp}/`);
    console.log(`>>>   cat ${mp}/datasets/<name>/items.jsonl`);
    console.log(`>>>   tree ${mp}/prompts/`);
    console.log("\n>>> Press Enter to unmount and exit...");

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
