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
  SlackResource,
  Workspace,
  type SlackConfig,
} from "@struktoai/mirage-node";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__HERE, "../../../.env.development") });

function buildConfig(): SlackConfig {
  const token = process.env.SLACK_BOT_TOKEN;
  if (token === undefined || token === "") {
    throw new Error("SLACK_BOT_TOKEN env var is required");
  }
  return { token };
}

async function main(): Promise<void> {
  const resource = new SlackResource(buildConfig());
  const ws = new Workspace({
    "/slack": new Mount(resource, { mode: MountMode.READ, fuse: true }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log("--- readdir() root ---");
    const sections = await readdir(mp);
    for (const s of sections) {
      console.log(`  ${s}`);
    }

    console.log("\n--- readdir() channels ---");
    const channels = await readdir(`${mp}/channels`);
    for (const ch of channels.slice(0, 5)) {
      console.log(`  ${ch}`);
    }

    if (channels.length > 0) {
      const ch = channels.find((c) => c.includes("general")) ?? channels[0]!;

      console.log(`\n--- readdir() ${ch} (last 5 dates) ---`);
      const dates = await readdir(`${mp}/channels/${ch}`);
      for (const d of dates.slice(-5)) {
        console.log(`  ${d}`);
      }

      if (dates.length > 0) {
        let found = false;
        for (const d of [...dates].reverse()) {
          const path = `${mp}/channels/${ch}/${d}/chat.jsonl`;
          const text = (await readFile(path, "utf-8")).trim();
          if (text !== "") {
            const lines = text.split("\n").filter((ln) => ln.trim() !== "");
            console.log(`\n--- readFile() ${d} ---`);
            console.log(`  messages: ${String(lines.length)}`);
            for (const line of lines.slice(0, 3)) {
              try {
                const msg = JSON.parse(line) as {
                  user?: string;
                  text?: string;
                };
                const user = msg.user ?? "?";
                const content = (msg.text ?? "").slice(0, 80);
                console.log(`  [${user}] ${content}`);
              } catch {
                break;
              }
            }
            found = true;
            break;
          }
        }
        if (!found) {
          console.log("\n  (no messages found in recent dates)");
        }
      }
    }

    console.log("\n--- readdir() users ---");
    const users = await readdir(`${mp}/users`);
    for (const u of users.slice(0, 5)) {
      console.log(`  ${u}`);
    }

    if (users.length > 0) {
      const userPath = `${mp}/users/${users[0]!}`;
      console.log(`\n--- readFile() ${users[0]!} ---`);
      const text = (await readFile(userPath, "utf-8")).trim();
      if (text !== "") {
        try {
          const data = JSON.parse(text) as {
            name?: string;
            id?: string;
            is_bot?: boolean;
          };
          console.log(`  name: ${String(data.name)}`);
          console.log(`  id: ${String(data.id)}`);
          console.log(`  is_bot: ${String(data.is_bot)}`);
        } catch {
          console.log(`  (raw: ${text.slice(0, 100)})`);
        }
      } else {
        console.log("  (empty)");
      }
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`);
    console.log(">>> Open another terminal and run:");
    console.log(`>>>   ls ${mp}/`);
    console.log(`>>>   cat ${mp}/channels/<channel>/<date>/chat.jsonl`);
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
