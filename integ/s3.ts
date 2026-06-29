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

import { getCalls, resetCalls } from "./s3_probe.ts";
import {
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CommandSafeguard,
  DEFAULT_COMMAND_SAFEGUARDS,
  GCSResource,
  MountMode,
  S3Resource,
  SeaweedFSResource,
  Workspace,
} from "@struktoai/mirage-node";
import { ConsistencyPolicy } from "@struktoai/mirage-core";
import { runNotFound } from "./cases.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "..", "data");
const SEED_OBJECTS = ["example.jsonl", "example.json"];
const S3_BUCKET = "mirage-integ-s3";
const GCS_BUCKET = "mirage-integ-gcs";
const MINIO_BUCKET = "mirage-integ-minio";
const SEAWEEDFS_BUCKET = "mirage-integ-seaweedfs";
const MOUNTS = ["/s3", "/gcs", "/minio", "/seaweedfs"];

const ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const REGION = process.env.S3_REGION ?? "us-east-1";
const ACCESS = process.env.AWS_ACCESS_KEY_ID ?? "minio";
const SECRET = process.env.AWS_SECRET_ACCESS_KEY ?? "minio123";

const DEC = new TextDecoder();

const PER_MOUNT_CASES: ReadonlyArray<readonly [string, string]> = [
  ["ls", `ls {m}/`],
  ["ls_data", `ls {m}/data/`],
  ["tree", `tree {m}/`],
  ["stat", `stat -c '%s %n' {m}/data/example.json`],
  ["cat_head", `cat {m}/data/example.json | head -n 5`],
  ["head_1_jsonl", `head -n 1 {m}/data/example.jsonl`],
  ["head_3_jsonl", `head -n 3 {m}/data/example.jsonl`],
  ["tail_2_jsonl", `tail -n 2 {m}/data/example.jsonl`],
  ["wc_l_jsonl", `wc -l {m}/data/example.jsonl`],
  ["wc_c_json", `wc -c {m}/data/example.json`],
  ["grep_c_mirage", `grep -c mirage {m}/data/example.jsonl`],
  ["grep_m1_mirage", `grep -m 1 mirage {m}/data/example.jsonl`],
  ["grep_head", `grep mirage {m}/data/example.jsonl | head -n 3`],
  ["grep_queue_wc", `grep queue-operation {m}/data/example.jsonl | wc -l`],
  ["grep_rl_item", `grep -rl item {m}/data/`],
  ["rg_l_item", `rg -l item {m}/data/`],
  ["grep_rc_mirage", `grep -rc mirage {m}/data/`],
  ["ls_file_json", `ls {m}/data/example.json`],
  ["find_json", `find {m}/ -name '*.json'`],
  ["find_type_f", `find {m}/data -type f | sort`],
  ["jq_version", `jq .metadata.version {m}/data/example.json`],
  ["jq_team_names", `jq '.departments[].teams[].name' {m}/data/example.json`],
  [
    "pipe_sort_uniq_wc",
    `cat {m}/data/example.jsonl | grep queue-operation | sort | uniq | wc -l`,
  ],
  ["md5_json", `md5 {m}/data/example.json`],
  ["sha256_json", `sha256sum {m}/data/example.json`],
  ["ls_l_data", `ls -l {m}/data/`],
  ["du_multi", `du {m}/data/example.json {m}/data/example.jsonl`],
  ["file_multi", `file {m}/data/example.json {m}/data/example.jsonl`],
  ["safeguard_cat_truncates", `cat {m}/data/example.jsonl`],
  ["safeguard_cat_pipe_uncapped", `cat {m}/data/example.jsonl | wc -l`],
];

const CROSS_CASES: ReadonlyArray<readonly [string, string]> = [
  ["head1_s3", `head -n 1 /s3/data/example.jsonl`],
  ["head1_gcs", `head -n 1 /gcs/data/example.jsonl`],
  ["wc_s3", `cat /s3/data/example.jsonl | wc -l`],
  ["wc_gcs", `cat /gcs/data/example.jsonl | wc -l`],
  ["grep_s3", `grep -c mirage /s3/data/example.jsonl`],
  ["grep_gcs", `grep -c mirage /gcs/data/example.jsonl`],
  ["concat_wc", `cat /s3/data/example.jsonl /gcs/data/example.jsonl | wc -l`],
];

const STREAMING_CASES: ReadonlyArray<readonly [string, string]> = [
  ["head_c100", `head -c 100 {m}/data/example.jsonl`],
  ["head_n1", `head -n 1 {m}/data/example.jsonl`],
  ["grep_m1", `grep -m 1 mirage {m}/data/example.jsonl`],
  ["cat_wc_full", `cat {m}/data/example.jsonl | wc -l`],
];

// Warm-read serving: a cat warms the file cache for the object, then each
// read-only command reads the same object and is served entirely from cache,
// pulling zero backend bytes. cat goes through the generic read-through and
// grep/head/tail/wc through the shared consumers; a regression that stopped
// serving warm reads would re-fetch the object and bytes would jump above 0.
const WARM_SERVE_CASES: ReadonlyArray<readonly [string, string]> = [
  ["warm_cat", `cat {m}/data/example.jsonl`],
  ["warm_grep", `grep mirage {m}/data/example.jsonl`],
  ["warm_head", `head -n 1 {m}/data/example.jsonl`],
  ["warm_tail", `tail -n 1 {m}/data/example.jsonl`],
  ["warm_wc", `wc -l {m}/data/example.jsonl`],
];

const EXIT_CODE_CASES: ReadonlyArray<readonly [string, string]> = [
  ["grep_match", `grep -q mirage {m}/data/example.jsonl`],
  ["grep_no_match", `grep -q zzzznomatch {m}/data/example.jsonl`],
];

const INDEX_CASES: ReadonlyArray<readonly [string, string]> = [
  ["ls_l", `ls -l {m}/data/`],
  ["tree", `tree {m}/`],
];

const TIMEOUT_CASES: ReadonlyArray<readonly [string, string]> = [
  ["timeout_sleep_fires", `sleep 2`],
];

function sdkClient(): S3Client {
  return new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
  });
}

async function seed(): Promise<void> {
  const client = sdkClient();
  try {
    for (const bucket of [
      S3_BUCKET,
      GCS_BUCKET,
      MINIO_BUCKET,
      SEAWEEDFS_BUCKET,
    ]) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (err) {
        const code = (err as { name?: string }).name;
        if (
          code !== "BucketAlreadyOwnedByYou" &&
          code !== "BucketAlreadyExists"
        )
          throw err;
      }
      for (const obj of SEED_OBJECTS) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `data/${obj}`,
            Body: readFileSync(join(DATA_DIR, obj)),
          }),
        );
      }
    }
  } finally {
    client.destroy();
  }
}

function buildWorkspace(): Workspace {
  const common = {
    region: REGION,
    endpoint: ENDPOINT,
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    forcePathStyle: true,
  };
  const s3 = new S3Resource({ bucket: S3_BUCKET, ...common });
  const gcs = new GCSResource({ bucket: GCS_BUCKET, ...common });
  const minio = new S3Resource({ bucket: MINIO_BUCKET, ...common });
  const seaweedfs = new SeaweedFSResource({
    bucket: SEAWEEDFS_BUCKET,
    ...common,
  });
  const cap = new CommandSafeguard({ maxLines: 20 });
  return new Workspace(
    { "/s3": s3, "/gcs": gcs, "/minio": minio, "/seaweedfs": seaweedfs },
    {
      mode: MountMode.READ,
      commandSafeguards: {
        "/s3": { cat: cap },
        "/gcs": { cat: cap },
        "/minio": { cat: cap },
        "/seaweedfs": { cat: cap },
      },
    },
  );
}

async function run(ws: Workspace, name: string, cmd: string): Promise<void> {
  process.stdout.write(`=== ${name} ===\n`);
  try {
    const result = await ws.execute(cmd);
    const out = DEC.decode(result.stdout);
    process.stdout.write(out.endsWith("\n") ? out : out + "\n");
    if (name.includes("safeguard_")) {
      const err = DEC.decode(result.stderr);
      if (err) process.stdout.write(err.endsWith("\n") ? err : err + "\n");
    }
  } catch (err) {
    process.stderr.write(
      `# ${name}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function runExit(
  ws: Workspace,
  name: string,
  cmd: string,
): Promise<void> {
  const result = await ws.execute(cmd);
  const err = DEC.decode(result.stderr);
  process.stdout.write(`=== ${name} ===\n`);
  process.stdout.write(`exit=${result.exitCode}\n`);
  if (err) process.stdout.write(err.endsWith("\n") ? err : err + "\n");
}

function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let body = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  body =
    quote === "'" ? body.replace(/'/g, "\\'") : body.replace(/"/g, '\\"');
  return quote + body + quote;
}

async function measureBytes(
  ws: Workspace,
  name: string,
  cmd: string,
): Promise<void> {
  await ws.cache.clear();
  const before = ws.records.reduce((sum, r) => sum + r.bytes, 0);
  const result = await ws.execute(cmd);
  const out = DEC.decode(result.stdout);
  const net = ws.records.reduce((sum, r) => sum + r.bytes, 0) - before;
  const trimmed = out.trim();
  const lines = trimmed === "" ? [] : trimmed.split("\n");
  const first = lines.length > 0 ? (lines[0] ?? "").slice(0, 48) : "";
  process.stdout.write(`=== ${name} ===\n`);
  process.stdout.write(
    `bytes=${net} lines=${lines.length} out0=${pyRepr(first)}\n`,
  );
}

async function warmServe(name: string, mount: string, cmd: string): Promise<void> {
  const ws = buildWorkspace();
  try {
    await ws.execute(`cat ${mount}/data/example.jsonl`);
    const before = ws.records.reduce((sum, r) => sum + r.bytes, 0);
    await ws.execute(cmd);
    const net = ws.records.reduce((sum, r) => sum + r.bytes, 0) - before;
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(`bytes=${net} served_from_cache=${net === 0}\n`);
  } finally {
    await ws.close();
  }
}

async function measureCalls(name: string, cmd: string): Promise<void> {
  const ws = buildWorkspace();
  resetCalls();
  try {
    await ws.execute(cmd);
  } catch {
    // count whatever calls were issued even on error
  }
  const c = getCalls();
  process.stdout.write(`=== ${name} ===\n`);
  process.stdout.write(
    `ListObjectsV2=${c.ListObjectsV2 ?? 0} HeadObject=${c.HeadObject ?? 0}\n`,
  );
  await ws.close();
}

// Cache consistency: read once (caches v1), mutate the object out-of-band via
// the raw SDK (new ETag), then read again. ALWAYS stats the backend and evicts
// the stale cache entry on every read so the second read returns v2; LAZY keeps
// serving the cached v1. A fresh single-purpose key is used and only cat (no ls)
// touches it, so stat hits HeadObject and carries the ETag fingerprint.
async function runConsistency(): Promise<void> {
  const client = sdkClient();
  const key = "data/consistency.txt";
  const enc = new TextEncoder();
  const policies: ReadonlyArray<readonly [ConsistencyPolicy, string]> = [
    [ConsistencyPolicy.ALWAYS, "always"],
    [ConsistencyPolicy.LAZY, "lazy"],
  ];
  try {
    for (const [policy, label] of policies) {
      await client.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: enc.encode("v1"),
        }),
      );
      const ws = new Workspace(
        {
          "/s3": new S3Resource({
            bucket: S3_BUCKET,
            region: REGION,
            endpoint: ENDPOINT,
            accessKeyId: ACCESS,
            secretAccessKey: SECRET,
            forcePathStyle: true,
          }),
        },
        { mode: MountMode.READ, consistency: policy },
      );
      const first = await ws.execute("cat /s3/data/consistency.txt");
      process.stdout.write(`=== consistency:${label}:first ===\n`);
      process.stdout.write(DEC.decode(first.stdout) + "\n");
      await client.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: enc.encode("v2"),
        }),
      );
      const second = await ws.execute("cat /s3/data/consistency.txt");
      process.stdout.write(`=== consistency:${label}:second ===\n`);
      process.stdout.write(DEC.decode(second.stdout) + "\n");
      await ws.close();
    }
  } finally {
    client.destroy();
  }
}

// In-band coherence: under LAZY (which never revalidates on its own), a mutation
// done through a mirage command must invalidate the parent listing at the write
// site, so a previously cached `ls` reflects the change. cp -> core copy, rm -r
// -> core rm_r: each first caches the listing with ls, mutates in-band, then
// lists again and must see fresh state. Mirrors s3.py _run_coherence.
async function runCoherence(): Promise<void> {
  const ws = new Workspace(
    {
      "/s3": new S3Resource({
        bucket: S3_BUCKET,
        region: REGION,
        endpoint: ENDPOINT,
        accessKeyId: ACCESS,
        secretAccessKey: SECRET,
        forcePathStyle: true,
      }),
    },
    { mode: MountMode.WRITE, consistency: ConsistencyPolicy.LAZY },
  );
  try {
    await ws.execute(
      "mkdir -p /s3/coh && echo one | tee /s3/coh/a.txt > /dev/null",
    );
    await run(ws, "coherence:seed_ls", "ls /s3/coh");
    await ws.execute("cp /s3/coh/a.txt /s3/coh/b.txt");
    await run(ws, "coherence:after_cp_ls", "ls /s3/coh");
    await ws.execute(
      "mkdir -p /s3/coh/sub && echo z | tee /s3/coh/sub/z.txt > /dev/null",
    );
    await run(ws, "coherence:after_mkdir_ls", "ls /s3/coh");
    await ws.execute("rm -r /s3/coh/sub");
    await run(ws, "coherence:after_rmr_ls", "ls /s3/coh");
  } finally {
    await ws.close();
  }
}

async function main(): Promise<void> {
  await seed();
  const ws = buildWorkspace();
  try {
    for (const mount of MOUNTS) {
      const tag = mount.slice(1);
      for (const [name, tmpl] of PER_MOUNT_CASES)
        await run(ws, `${tag}:${name}`, tmpl.replaceAll("{m}", mount));
    }
    for (const [name, cmd] of CROSS_CASES) await run(ws, `cross:${name}`, cmd);
    for (const mount of MOUNTS) {
      const tag = mount.slice(1);
      for (const [name, tmpl] of STREAMING_CASES)
        await measureBytes(
          ws,
          `${tag}:stream:${name}`,
          tmpl.replaceAll("{m}", mount),
        );
    }
    for (const mount of MOUNTS) {
      const tag = mount.slice(1);
      for (const [name, tmpl] of WARM_SERVE_CASES)
        await warmServe(
          `${tag}:warm:${name}`,
          mount,
          tmpl.replaceAll("{m}", mount),
        );
    }
    for (const mount of MOUNTS) {
      const tag = mount.slice(1);
      for (const [name, tmpl] of INDEX_CASES)
        await measureCalls(
          `${tag}:calls:${name}`,
          tmpl.replaceAll("{m}", mount),
        );
    }
    for (const mount of MOUNTS) {
      const tag = mount.slice(1);
      for (const [name, tmpl] of EXIT_CODE_CASES)
        await runExit(ws, `${tag}:exit:${name}`, tmpl.replaceAll("{m}", mount));
    }
    const prevSleep = DEFAULT_COMMAND_SAFEGUARDS.sleep;
    DEFAULT_COMMAND_SAFEGUARDS.sleep = new CommandSafeguard({
      timeoutSeconds: 0.1,
    });
    try {
      for (const [name, cmd] of TIMEOUT_CASES)
        await runExit(ws, `safeguard:${name}`, cmd);
    } finally {
      if (prevSleep === undefined) delete DEFAULT_COMMAND_SAFEGUARDS.sleep;
      else DEFAULT_COMMAND_SAFEGUARDS.sleep = prevSleep;
    }
    await runNotFound(ws, "/s3");
    await runConsistency();
    await runCoherence();
  } finally {
    await ws.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
