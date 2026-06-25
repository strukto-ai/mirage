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

// SeaweedFS mounted as a real FUSE filesystem. Seeds a few objects, then
// external processes can `cat $mp/seaweedfs/data/config.json` just like a
// local directory.
//
// Requires: macFUSE / libfuse3 + @zkochan/fuse-native (see /typescript/setup/fuse).
// Point it at a SeaweedFS S3 gateway (default http://localhost:8333).
// Loads credentials from .env.development at the repo root.
import {
  Mount,
  MountMode,
  SeaweedFSResource,
  Workspace,
  type SeaweedFSConfig,
} from "@struktoai/mirage-node";
import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__HERE, "../../../.env.development") });

const SEED_KEYS = [
  "/seaweedfs/data/example.jsonl",
  "/seaweedfs/data/config.json",
  "/seaweedfs/notes.txt",
];

function configFromEnv(): SeaweedFSConfig {
  return {
    bucket: process.env.SEAWEEDFS_BUCKET ?? "mirage-demo",
    endpoint: process.env.SEAWEEDFS_ENDPOINT ?? "http://localhost:8333",
    accessKeyId: process.env.SEAWEEDFS_ACCESS_KEY ?? "any",
    secretAccessKey: process.env.SEAWEEDFS_SECRET_KEY ?? "any",
  };
}

async function seed(ws: Workspace): Promise<void> {
  await ws.execute(
    `echo '{"event":"queue-operation","tool":"mirage"}' > /seaweedfs/data/example.jsonl`,
  );
  await ws.execute(
    `echo '{"event":"read","tool":"mirage"}' >> /seaweedfs/data/example.jsonl`,
  );
  await ws.execute(
    `echo '{"event":"queue-operation","tool":"other"}' >> /seaweedfs/data/example.jsonl`,
  );
  await ws.execute(
    `echo '{"name":"mirage","version":1,"tags":["s3","seaweedfs"]}' > /seaweedfs/data/config.json`,
  );
  await ws.execute('echo "hello from seaweedfs" > /seaweedfs/notes.txt');
}

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const ws = new Workspace({
    "/seaweedfs/": new Mount(new SeaweedFSResource(cfg), {
      mode: MountMode.WRITE,
      fuse: true,
    }),
  });

  try {
    await seed(ws);
    await ws.fuseReady();
    const mp = ws.fuseMountpoint as string;

    console.log(
      `=== FUSE MODE — SeaweedFS at ${cfg.endpoint} (bucket ${cfg.bucket}) ===`,
    );
    console.log(`  mountpoint = ${mp}\n`);

    try {
      console.log("--- virtual executor: stats via /seaweedfs ---");
      const ls = await ws.execute("ls /seaweedfs/data");
      console.log(
        `  ls /seaweedfs/data : ${ls.stdoutText.trim().split("\n").join(", ")}`,
      );
      const stat = await ws.execute("stat /seaweedfs/data/example.jsonl");
      console.log(`  stat example.jsonl : ${stat.stdoutText.trim()}`);
      const grep = await ws.execute(
        "grep -c queue-operation /seaweedfs/data/example.jsonl",
      );
      console.log(`  grep -c            : ${grep.stdoutText.trim()}`);

      console.log();
      console.log(">>> Mount is live. From ANOTHER terminal you can:");
      console.log(`>>>   ls  ${mp}/data/`);
      console.log(`>>>   cat ${mp}/data/config.json`);
      console.log(`>>>   wc -l ${mp}/data/example.jsonl`);
    } finally {
      for (const key of SEED_KEYS) await ws.execute(`rm ${key}`);
    }
  } finally {
    await ws.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
