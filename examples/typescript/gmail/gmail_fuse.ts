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

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  GmailResource,
  Mount,
  MountMode,
  Workspace,
  type GmailConfig,
} from "@struktoai/mirage-node";
import dotenv from "dotenv";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({
  path: resolve(__HERE, "../../../.env.development"),
  override: true,
});

function buildConfig(): GmailConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? "";
  if (clientId === "" || clientSecret === "" || refreshToken === "") {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required",
    );
  }
  return { clientId, clientSecret, refreshToken };
}

async function main(): Promise<void> {
  const resource = new GmailResource(buildConfig());
  const ws = new Workspace({
    "/gmail": new Mount(resource, { mode: MountMode.READ, fuse: true }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log("--- readdir() labels ---");
    const labels = await readdir(mp);
    for (const label of labels) console.log(`  ${label}`);

    if (labels.includes("INBOX")) {
      const inboxPath = `${mp}/INBOX`;
      console.log("\n--- readdir() INBOX (first 5 dates) ---");
      const dates = await readdir(inboxPath);
      for (const date of dates.slice(0, 5)) console.log(`  ${date}`);

      const firstDate = dates[0];
      if (firstDate !== undefined) {
        const datePath = `${inboxPath}/${firstDate}`;
        console.log(`\n--- readdir() ${firstDate} (first 5 messages) ---`);
        const messages = await readdir(datePath);
        for (const message of messages.slice(0, 5)) console.log(`  ${message}`);

        const firstMessage = messages.find((message) =>
          message.endsWith(".gmail.json"),
        );
        if (firstMessage !== undefined) {
          const messagePath = `${datePath}/${firstMessage}`;
          console.log("\n--- stat before read ---");
          console.log(`  size: ${(await stat(messagePath)).size}`);

          console.log(`--- readFile() ${firstMessage.slice(0, 60)} ---`);
          const content = await readFile(messagePath, "utf8");
          const message = JSON.parse(content) as {
            subject?: string;
            from?: string;
          };
          console.log(`  subject: ${message.subject ?? "N/A"}`);
          console.log(`  from: ${message.from ?? "N/A"}`);
          console.log(`  rendered bytes: ${Buffer.byteLength(content)}`);

          console.log("--- stat after read ---");
          console.log(`  size: ${(await stat(messagePath)).size}`);
        }
      }
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`);
    console.log(">>> Try in another terminal:");
    console.log(`>>>   ls ${mp}/`);
    console.log(`>>>   ls ${mp}/INBOX/`);
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
