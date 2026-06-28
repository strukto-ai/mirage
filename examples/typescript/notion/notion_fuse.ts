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
  Mount,
  MountMode,
  NotionResource,
  Workspace,
  type NotionConfig,
} from "@struktoai/mirage-node";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__HERE, "../../../.env.development") });

function buildConfig(): NotionConfig {
  const apiKey = process.env.NOTION_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("NOTION_API_KEY env var is required");
  }
  return { apiKey };
}

async function main(): Promise<void> {
  const resource = new NotionResource(buildConfig());
  const ws = new Workspace({
    "/notion": new Mount(resource, { mode: MountMode.READ, fuse: true }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log("--- readdir() /notion/pages ---");
    const pages = await readdir(`${mp}/pages`);
    for (const p of pages.slice(0, 5)) console.log(`  ${p}`);

    if (pages.length === 0) {
      console.log("  (no pages)");
      return;
    }
    const pagePath = `${mp}/pages/${pages[0]!}`;

    console.log(`\n--- readdir() ${pages[0]!} ---`);
    for (const c of await readdir(pagePath)) console.log(`  ${c}`);

    console.log("\n--- readFile() page.json ---");
    const bytes = await readFile(`${pagePath}/page.json`, "utf-8");
    const data = JSON.parse(bytes) as { title?: string; url?: string };
    console.log(`  title: ${data.title ?? ""}`);
    console.log(`  url: ${data.url ?? ""}`);

    console.log(`\n>>> FUSE mounted at: ${mp}`);
    console.log(">>> Open another terminal and run:");
    console.log(`>>>   ls ${mp}/pages/`);
    console.log(`>>>   cat ${mp}/pages/<page>/page.json | jq .title`);
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
