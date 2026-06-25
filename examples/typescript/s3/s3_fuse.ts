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

// S3 mounted as a real FUSE filesystem with two mounts:
//   /s3/    — unscoped, full bucket
//   /deep/  — same bucket, scoped via keyPrefix=subdata/subsubdata/
//
// External processes can then do `cat $mp/deep/example.json` just like
// a local directory; the prefix is transparent.
//
// Requires: macFUSE / libfuse3 + @zkochan/fuse-native (see /typescript/setup/fuse).
// Loads credentials from .env.development at the repo root.
import {
  Mount,
  MountMode,
  S3Resource,
  Workspace,
  type S3Config,
} from "@struktoai/mirage-node";
import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__HERE, "../../../.env.development") });

function baseConfig(): S3Config {
  if (process.env.AWS_S3_BUCKET === undefined) {
    throw new Error("AWS_S3_BUCKET not set (expected in .env.development)");
  }
  return {
    bucket: process.env.AWS_S3_BUCKET,
    region: process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    ...(process.env.AWS_ACCESS_KEY_ID !== undefined &&
    process.env.AWS_SECRET_ACCESS_KEY !== undefined
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : {}),
  };
}

async function main(): Promise<void> {
  const cfg = baseConfig();
  const deepCfg: S3Config = { ...cfg, keyPrefix: "subdata/subsubdata/" };

  const ws = new Workspace({
    "/s3/": new Mount(new S3Resource(cfg), {
      mode: MountMode.READ,
      fuse: true,
    }),
    "/deep/": new S3Resource(deepCfg),
  });

  try {
    await ws.fuseReady();
    const mp = ws.fuseMountpoint as string;

    console.log(`=== FUSE MODE — bucket: ${cfg.bucket} ===`);
    console.log(`  mountpoint = ${mp}`);
    console.log(`  /deep keyPrefix = ${JSON.stringify(deepCfg.keyPrefix)}\n`);

    console.log("--- virtual executor: stats via /deep ---");
    const ls = await ws.execute("ls /deep");
    console.log(
      `  ls /deep      : ${ls.stdoutText.trim().split("\n").slice(0, 3).join(", ")}, ...`,
    );
    const stat = await ws.execute("stat /deep/example.jsonl");
    console.log(`  stat /deep/example.jsonl : ${stat.stdoutText.trim()}`);
    const grep = await ws.execute("grep -c mirage /deep/example.jsonl");
    console.log(`  grep -c mirage           : ${grep.stdoutText.trim()}`);
    const rg = await ws.execute("rg -l mirage /deep");
    console.log(
      `  rg -l mirage /deep       : ${rg.stdoutText.trim().split("\n").join(" | ")}`,
    );

    console.log();
    console.log(">>> Mount is live. From ANOTHER terminal you can:");
    console.log(`>>>   ls  ${mp}/data/`);
    console.log(`>>>   cat ${mp}/example.json`);
    console.log(`>>>   wc -l ${mp}/example.jsonl`);
    console.log(
      ">>> (/deep reads s3://<bucket>/subdata/subsubdata/ via ws.execute)",
    );
  } finally {
    await ws.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
