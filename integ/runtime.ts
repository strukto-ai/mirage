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

import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { MongoClient } from "mongodb";
import {
  CommandSafeguard,
  MongoDBResource,
  MountMode,
  RAMResource,
  RedisResource,
  S3Resource,
  Workspace,
} from "@struktoai/mirage-node";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/0";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const S3_KEY = process.env.AWS_ACCESS_KEY_ID ?? "minio";
const S3_SECRET = process.env.AWS_SECRET_ACCESS_KEY ?? "minio123";
const DB = "mirage_integ_runtime";
const BUCKET = "mirage-integ-runtime-ts";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

const SLOW_SCRIPT = "n = 0\nfor i in range(300000000):\n    n = n + 1\n";

const ANALYZE_SCRIPT = `from pathlib import Path
ram = Path('/ram/data.txt').read_text().strip()
s3 = Path('/s3/greeting.txt').read_text().strip()
print('ram:', ram)
print('s3:', s3)
print('argv sum:', int(argv[1]) + int(argv[2]))
`;

const CASES: [string, string][] = [
  [
    "py3_ram_read",
    "python3 -c \"from pathlib import Path; print(Path('/ram/data.txt').read_text().strip().upper())\"",
  ],
  [
    "py3_redis_read",
    "python3 -c \"from pathlib import Path; print(Path('/redis/notes.txt').read_text().strip())\"",
  ],
  [
    "py3_s3_read",
    "python3 -c \"from pathlib import Path; print(Path('/s3/greeting.txt').read_text().strip())\"",
  ],
  [
    "py3_mongodb_meta",
    `python3 -c "import json; from pathlib import Path; meta = json.loads(Path('/mongodb/${DB}/database.json').read_text()); print(meta['database'], len(meta['collections']))"`,
  ],
  [
    "py3_mongodb_schema",
    `python3 -c "import json; from pathlib import Path; s = json.loads(Path('/mongodb/${DB}/collections/books/schema.json').read_text()); print(s['name'], s['kind'], s['document_count'], [f['path'] for f in s['fields']])"`,
  ],
  [
    "py3_mongodb_docs",
    `python3 -c "from pathlib import Path; lines = Path('/mongodb/${DB}/collections/books/documents.jsonl').read_text().splitlines(); print('books:', len(lines))"`,
  ],
  ["py3_script_argv", "python3 /ram/analyze.py 40 2"],
  [
    "py3_write_back",
    "python3 -c \"from pathlib import Path; Path('/ram/out.txt').write_text('written-by-python3')\" && cat /ram/out.txt",
  ],
  ["python_alias", "python -c 'print(6 * 7)'"],
  [
    "py3_env",
    "export GREETING=hello-runtime && python3 -c \"import os; print(os.getenv('GREETING'))\"",
  ],
  [
    // str(p) instead of p.name: the monty JS binding returns iterdir
    // entries as plain strings (the Python binding returns Path objects).
    "py3_iterdir",
    "python3 -c \"from pathlib import Path; print(sorted(str(p).split('/')[-1] for p in Path('/ram').iterdir()))\"",
  ],
];

const ERROR_CASES: [string, string][] = [
  [
    "py3_missing_file",
    "python3 -c \"from pathlib import Path; print(Path('/ram/nope.txt').read_text())\"",
  ],
  [
    "py3_host_fs_invisible",
    "python3 -c \"from pathlib import Path; print(Path('/etc/passwd').read_text())\"",
  ],
];

async function seedMongo(): Promise<void> {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.db(DB).dropDatabase();
    await client
      .db(DB)
      .collection("books")
      .insertMany([
        { _id: 1 as never, title: "alpha" },
        { _id: 2 as never, title: "beta" },
      ]);
    await client
      .db(DB)
      .collection("authors")
      .insertMany([{ _id: 1 as never, name: "ada" }]);
  } finally {
    await client.close();
  }
}

async function seedS3(): Promise<void> {
  const client = new S3Client({
    region: "us-east-1",
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch {
    // bucket already exists from a prior run
  }
  await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: "greeting.txt", Body: "hello from s3\n" }),
  );
  client.destroy();
}

function buildWorkspace(runId: string): Workspace {
  const ram = new RAMResource();
  ram.store.files.set("/data.txt", ENC.encode("hello from ram\n"));
  ram.store.files.set("/analyze.py", ENC.encode(ANALYZE_SCRIPT));
  const redis = new RedisResource({
    url: REDIS_URL,
    keyPrefix: `mirage-integ-runtime-ts-${runId}/`,
  });
  const s3 = new S3Resource({
    bucket: BUCKET,
    region: "us-east-1",
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    accessKeyId: S3_KEY,
    secretAccessKey: S3_SECRET,
  });
  const mongodb = new MongoDBResource({ uri: MONGODB_URI, databases: [DB] });
  return new Workspace(
    { "/ram": ram, "/redis": redis, "/s3": s3, "/mongodb": mongodb },
    { mode: MountMode.EXEC, pythonRuntime: "monty" },
  );
}

async function run(ws: Workspace, name: string, cmd: string): Promise<void> {
  const io = await ws.execute(cmd);
  const out = DEC.decode(io.stdout);
  console.log(`=== ${name} ===`);
  if (out) process.stdout.write(out.endsWith("\n") ? out : out + "\n");
}

async function runError(ws: Workspace, name: string, cmd: string): Promise<void> {
  const io = await ws.execute(cmd);
  console.log(`=== ${name} ===`);
  console.log(`exit_code=${io.exitCode}`);
}

async function main(): Promise<void> {
  await seedS3();
  await seedMongo();
  const runId = Math.random().toString(36).slice(2, 10);
  const ws = buildWorkspace(runId);
  await ws.execute("echo redis says hi > /redis/notes.txt");
  for (const [name, cmd] of CASES) await run(ws, name, cmd);
  for (const [name, cmd] of ERROR_CASES) await runError(ws, name, cmd);

  const slowRam = new RAMResource();
  slowRam.store.files.set("/slow.py", ENC.encode(SLOW_SCRIPT));
  const wsSg = new Workspace(
    { "/ram": slowRam },
    {
      mode: MountMode.EXEC,
      pythonRuntime: "monty",
      commandSafeguards: {
        "/ram": { python3: new CommandSafeguard({ timeoutSeconds: 1 }) },
      },
    },
  );
  // cd first: the per-mount safeguard guards commands dispatched on
  // that mount, and python3 dispatches via the working directory.
  await runError(wsSg, "py3_safeguard_timeout", "cd /ram && python3 /ram/slow.py");
  await wsSg.close();
  await ws.close();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
