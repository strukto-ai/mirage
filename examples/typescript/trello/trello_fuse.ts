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
  TrelloResource,
  Workspace,
  type TrelloConfig,
} from "@struktoai/mirage-node";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__HERE, "../../../.env.development") });

function buildConfig(): TrelloConfig {
  const apiKey = process.env.TRELLO_API_KEY;
  const apiToken = process.env.TRELLO_API_TOKEN;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("TRELLO_API_KEY env var is required");
  }
  if (apiToken === undefined || apiToken === "") {
    throw new Error("TRELLO_API_TOKEN env var is required");
  }
  return { apiKey, apiToken };
}

async function main(): Promise<void> {
  const resource = new TrelloResource(buildConfig());
  const ws = new Workspace({
    "/trello": new Mount(resource, { mode: MountMode.READ, fuse: true }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log("--- readdir() /trello ---");
    for (const r of await readdir(mp)) console.log(`  ${r}`);

    console.log("\n--- readdir() /trello/workspaces ---");
    const workspaces = await readdir(`${mp}/workspaces`);
    for (const w of workspaces.slice(0, 5)) console.log(`  ${w}`);

    if (workspaces.length === 0) {
      console.log("  (no workspaces)");
      return;
    }
    const ws0 = workspaces[0]!;

    console.log(`\n--- readFile() ${ws0}/workspace.json ---`);
    const wsBytes = await readFile(
      `${mp}/workspaces/${ws0}/workspace.json`,
      "utf-8",
    );
    console.log(`  ${wsBytes.trim().slice(0, 200)}`);

    console.log(`\n--- readdir() ${ws0}/boards ---`);
    const boards = await readdir(`${mp}/workspaces/${ws0}/boards`);
    for (const b of boards.slice(0, 5)) console.log(`  ${b}`);

    if (boards.length > 0) {
      const b0 = boards[0]!;
      const boardPath = `${mp}/workspaces/${ws0}/boards/${b0}`;

      console.log(`\n--- readFile() ${b0}/board.json ---`);
      const boardBytes = await readFile(`${boardPath}/board.json`, "utf-8");
      console.log(`  ${boardBytes.trim().slice(0, 250)}`);

      console.log(`\n--- readdir() ${b0}/lists ---`);
      const lists = await readdir(`${boardPath}/lists`);
      for (const l of lists.slice(0, 5)) console.log(`  ${l}`);

      if (lists.length > 0) {
        const l0 = lists[0]!;
        const cards = await readdir(`${boardPath}/lists/${l0}/cards`);
        console.log(
          `\n--- readdir() ${l0}/cards: ${String(cards.length)} cards ---`,
        );
      }
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`);
    console.log(">>> Open another terminal and run:");
    console.log(`>>>   ls ${mp}/workspaces/`);
    console.log(`>>>   cat ${mp}/workspaces/<ws>/boards/<board>/board.json`);
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
