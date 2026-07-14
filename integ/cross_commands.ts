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

import {
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  FileStat,
  MountMode,
  RAMResource,
  RedisResource,
  S3Resource,
  Workspace,
} from "@struktoai/mirage-node";

const S3_BUCKET = "mirage-integ-cross";
const ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const REGION = process.env.S3_REGION ?? "us-east-1";
const ACCESS = process.env.AWS_ACCESS_KEY_ID ?? "minio";
const SECRET = process.env.AWS_SECRET_ACCESS_KEY ?? "minio123";

const DEC = new TextDecoder();
const ENC = new TextEncoder();

let fail = 0;

function check(label: string, cond: boolean): void {
  if (cond) {
    process.stdout.write(`OK   ${label}\n`);
  } else {
    process.stdout.write(`FAIL ${label}\n`);
    fail += 1;
  }
}

async function run(
  ws: Workspace,
  cmd: string,
): Promise<[string, string, number]> {
  const io = await ws.execute(cmd);
  return [DEC.decode(io.stdout), DEC.decode(io.stderr), io.exitCode];
}

function sdkClient(): S3Client {
  return new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
  });
}

async function putObject(
  client: S3Client,
  key: string,
  body: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: ENC.encode(body),
    }),
  );
}

async function seedTree(ws: Workspace, base: string): Promise<void> {
  await run(ws, `mkdir -p ${base}/dir/sub`);
  await run(ws, `mkdir -p ${base}/dir/empty`);
  await run(ws, `printf 'aaa\\n' > ${base}/dir/a.txt`);
  await run(ws, `printf 'bbb\\n' > ${base}/dir/sub/b.txt`);
}

// cp -r the whole tree across mounts and verify the files (and, for backends
// with real directories, the empty subdirectory) landed.
async function checkRecursive(
  ws: Workspace,
  dst: string,
  label: string,
  expectDirs: boolean,
): Promise<void> {
  await run(ws, `cp -r /ram/dir ${dst}/copied`);
  let [out] = await run(ws, `cat ${dst}/copied/a.txt`);
  check(`${label}: cp -r a.txt`, out === "aaa\n");
  [out] = await run(ws, `cat ${dst}/copied/sub/b.txt`);
  check(`${label}: cp -r sub/b.txt`, out === "bbb\n");
  if (expectDirs) {
    [out] = await run(ws, `ls ${dst}/copied`);
    check(`${label}: cp -r preserves empty dir`, out.includes("empty"));
  }
}

// cp -rn into an existing mapped tree: an existing file is kept, a new file is
// still copied (GNU per-file no-clobber).
async function checkNoClobber(
  ws: Workspace,
  dst: string,
  label: string,
): Promise<void> {
  await run(ws, `mkdir -p ${dst}/nc/dir`);
  await run(ws, `printf 'keep\\n' > ${dst}/nc/dir/a.txt`);
  await run(ws, `cp -rn /ram/dir ${dst}/nc`);
  let [out] = await run(ws, `cat ${dst}/nc/dir/a.txt`);
  check(`${label}: cp -rn keeps existing file`, out === "keep\n");
  [out] = await run(ws, `cat ${dst}/nc/dir/sub/b.txt`);
  check(`${label}: cp -rn copies new file`, out === "bbb\n");
}

// cp without -r on a directory is an error (GNU), not a silent copy.
async function checkOmitDirectory(
  ws: Workspace,
  dst: string,
  label: string,
): Promise<void> {
  const [, err, code] = await run(ws, `cp /ram/dir ${dst}/nope`);
  check(
    `${label}: cp dir without -r fails`,
    code === 1 && err.includes("omitting directory"),
  );
}

// Multi-file reads whose operands span two mounts must aggregate exactly like
// the single-mount commands (GNU): cat concatenates, head/tail emit
// ==> path <== banners, wc prints a total, grep prefixes each match.
async function checkReadFamily(
  ws: Workspace,
  dst: string,
  label: string,
): Promise<void> {
  const src = "/ram/dir/a.txt";
  const other = `${dst}/copied/sub/b.txt`;
  const copied = `${dst}/copied/a.txt`;
  let [out] = await run(ws, `cat ${src} ${other}`);
  check(`${label}: cat aggregates`, out === "aaa\nbbb\n");
  [out] = await run(ws, `head -n 1 ${src} ${copied}`);
  check(
    `${label}: head banners`,
    out.includes(`==> ${src} <==`) && out.includes(`==> ${copied} <==`),
  );
  [out] = await run(ws, `tail -n 1 ${src} ${other}`);
  check(
    `${label}: tail banners`,
    out.includes(`==> ${src} <==`) && out.includes("bbb"),
  );
  [out] = await run(ws, `wc -l ${src} ${copied}`);
  check(`${label}: wc total`, out.includes("total"));
  [out] = await run(ws, `grep aaa ${src} ${copied}`);
  check(
    `${label}: grep prefixes`,
    out.includes(`${src}:aaa`) && out.includes(`${copied}:aaa`),
  );
  [out] = await run(ws, `rg aaa ${src} ${copied}`);
  check(
    `${label}: rg prefixes`,
    out.includes(`${src}:aaa`) && out.includes(`${copied}:aaa`),
  );
  // A non-numeric -n is rejected by the shared head/tail generic (GNU), exit 1.
  const hbad = await run(ws, `head -n abc ${src} ${copied}`);
  check(`${label}: head invalid -n`, hbad[2] === 1 && hbad[1].includes("abc"));
  const tbad = await run(ws, `tail -n abc ${src} ${copied}`);
  check(`${label}: tail invalid -n`, tbad[2] === 1 && tbad[1].includes("abc"));
  // A missing operand carries the GNU strerror suffix, like single-mount:
  // cat exercises the STREAM strategy, grep the FANOUT strategy.
  const miss = `${dst}/copied/missing.txt`;
  const cmiss = await run(ws, `cat ${src} ${miss}`);
  check(
    `${label}: cat missing strerror`,
    cmiss[2] === 1 && cmiss[1] === `cat: ${miss}: No such file or directory\n`,
  );
  // grep still searches the good operand and exits 0 on a match, with the
  // missing operand reported on stderr (matching single-mount grep).
  const gmiss = await run(ws, `grep aaa ${src} ${miss}`);
  check(
    `${label}: grep missing strerror`,
    gmiss[2] === 0 &&
      gmiss[0].includes(`${src}:aaa`) &&
      gmiss[1] === `grep: ${miss}: No such file or directory\n`,
  );
}

// One good + one missing operand: GNU keeps the good operand's output,
// reports the missing operand on stderr via the shared formatter, and exits
// 1. Single-mount and cross-mount must produce identical bytes.
async function checkPartialRead(
  ws: Workspace,
  dst: string,
  label: string,
): Promise<void> {
  const src = "/ram/dir/a.txt";
  const miss = `${dst}/copied/nope.txt`;
  let [out, err, code] = await run(ws, `cat ${src} ${miss}`);
  check(
    `${label}: cat keeps partial output`,
    out === "aaa\n" &&
      code === 1 &&
      err === `cat: ${miss}: No such file or directory\n`,
  );
  [out, err, code] = await run(ws, `wc -l ${src} ${miss}`);
  check(
    `${label}: wc keeps total`,
    out === `1 ${src}\n1 total\n` &&
      code === 1 &&
      err === `wc: ${miss}: No such file or directory\n`,
  );
  [out, err, code] = await run(ws, `head -n 1 ${src} ${miss}`);
  check(
    `${label}: head keeps banner`,
    out === `==> ${src} <==\naaa\n` &&
      code === 1 &&
      err === `head: ${miss}: No such file or directory\n`,
  );
  [out, err, code] = await run(ws, `tail -n 1 ${src} ${miss}`);
  check(
    `${label}: tail keeps banner`,
    out === `==> ${src} <==\naaa\n` &&
      code === 1 &&
      err === `tail: ${miss}: No such file or directory\n`,
  );
  // nl rides the STREAM strategy cross-mount: the error line must carry
  // nl's own name, not the cat sub-run that fetched the operand.
  [out, err, code] = await run(ws, `nl ${src} ${miss}`);
  check(
    `${label}: nl keeps output, own name`,
    out === "     1\taaa\n" &&
      code === 1 &&
      err === `nl: ${miss}: No such file or directory\n`,
  );
  [out, err, code] = await run(ws, `md5 ${src} ${miss}`);
  check(
    `${label}: md5 keeps good hash`,
    out === `5c9597f3c8245907ea71a89d9d39d08e  ${src}\n` &&
      code === 1 &&
      err === `md5: ${miss}: No such file or directory\n`,
  );
  // stat fans out per operand; mtimes vary, so pin shape and exit only.
  [out, err, code] = await run(ws, `stat ${src} ${miss}`);
  check(
    `${label}: stat keeps good row`,
    out.includes("name=a.txt") &&
      code === 1 &&
      err === `stat: ${miss}: No such file or directory\n`,
  );
  [out, err, code] = await run(ws, `cut -c1 ${src} ${miss}`);
  check(
    `${label}: cut keeps partial output`,
    out === "a\n" && code === 1 && err === `cut: ${miss}: No such file or directory\n`,
  );
  [out, err, code] = await run(ws, `tac ${src} ${miss}`);
  check(
    `${label}: tac keeps partial output`,
    out === "aaa\n" && code === 1 && err === `tac: ${miss}: No such file or directory\n`,
  );
  [out, err, code] = await run(ws, `sed s/a/X/ ${src} ${miss}`);
  check(
    `${label}: sed keeps partial output`,
    out === "Xaa\n" && code === 1 && err === `sed: ${miss}: No such file or directory\n`,
  );
  // sort aborts on any failed operand, single- and cross-mount alike.
  [out, err, code] = await run(ws, `sort ${src} ${miss}`);
  check(
    `${label}: sort aborts`,
    out === "" && code === 1 && err === `sort: ${miss}: No such file or directory\n`,
  );
}

// diff/cmp two files that live on different mounts: identical operands exit 0
// with no output, differing operands exit 1 and report the change.
async function checkCompare(
  ws: Workspace,
  dst: string,
  label: string,
): Promise<void> {
  const same = `${dst}/copied/a.txt`;
  const other = `${dst}/copied/sub/b.txt`;
  const src = "/ram/dir/a.txt";
  let [out, , code] = await run(ws, `diff ${src} ${same}`);
  check(`${label}: diff identical`, code === 0 && out === "");
  [out, , code] = await run(ws, `diff ${src} ${other}`);
  check(
    `${label}: diff differing`,
    code === 1 && out.includes("aaa") && out.includes("bbb"),
  );
  [, , code] = await run(ws, `cmp ${src} ${same}`);
  check(`${label}: cmp identical`, code === 0);
  [out, , code] = await run(ws, `cmp ${src} ${other}`);
  check(`${label}: cmp differing`, code === 1 && out.includes("differ"));
  // A missing operand carries the GNU strerror suffix, like single-mount.
  const miss = `${dst}/copied/missing.txt`;
  const [, err, missCode] = await run(ws, `diff ${src} ${miss}`);
  check(
    `${label}: diff missing strerror`,
    missCode === 1 && err === `diff: ${miss}: No such file or directory\n`,
  );
}

// cd must traverse mount boundaries within one session: hop straight from one
// mount to another, walk `..` up to the shared virtual root above all mounts,
// take a relative `..` chain across the boundary, swap with `cd -`, collapse a
// leading `//`, honor GNU options on a cross-mount target, and search a $CDPATH
// that spans two mounts.
async function checkCdCrossMount(
  ws: Workspace,
  dst: string,
  label: string,
): Promise<void> {
  const rel = "../.." + dst + "/copied";
  const bare = dst.slice(1);
  let [out] = await run(ws, `(cd /ram/dir && cd ${dst}/copied && pwd)`);
  check(`${label}: cd hops mounts`, out.trim() === `${dst}/copied`);
  [out] = await run(ws, "(cd /ram/dir && cd / && pwd)");
  check(`${label}: cd / above mounts`, out.trim() === "/");
  [out] = await run(ws, `(cd /ram/dir && cd ${rel} && pwd)`);
  check(`${label}: relative .. crosses mounts`, out.trim() === `${dst}/copied`);
  [out] = await run(ws, `(cd /ram && cd ${dst} && cd - > /dev/null && pwd)`);
  check(`${label}: cd - swaps mounts`, out.trim() === "/ram");
  [out] = await run(ws, `(cd //${bare}/copied && pwd)`);
  check(`${label}: // collapses on mount`, out.trim() === `${dst}/copied`);
  [out] = await run(ws, `(cd /ram && cd -P ${dst}/copied && pwd)`);
  check(`${label}: cd -P cross-mount`, out.trim() === `${dst}/copied`);
  [out] = await run(ws, `(cd /ram && cd -- ${dst}/copied && pwd)`);
  check(`${label}: cd -- cross-mount`, out.trim() === `${dst}/copied`);
  [out] = await run(ws, `(export CDPATH=/ram:${dst} && cd copied && pwd)`);
  const lines = out.trim().split("\n");
  check(
    `${label}: CDPATH spans mounts`,
    lines[lines.length - 1] === `${dst}/copied`,
  );
}

// mv a directory across mounts: destination gets the tree, source is gone.
async function checkMove(
  ws: Workspace,
  dst: string,
  label: string,
): Promise<void> {
  await run(ws, "mkdir -p /ram/movedir/sub");
  await run(ws, "printf 'm\\n' > /ram/movedir/sub/c.txt");
  await run(ws, `mv /ram/movedir ${dst}/moved`);
  let [out, , code] = await run(ws, `cat ${dst}/moved/sub/c.txt`);
  check(`${label}: mv tree to dest`, out === "m\n");
  [out, , code] = await run(ws, "cat /ram/movedir/sub/c.txt");
  check(`${label}: mv removes source`, code !== 0);
}

// Namespace links are mount-agnostic: a link homed on /ram whose target
// lives on another mount must read, write, and copy through that mount,
// and the reverse direction (link homed on the other mount, target in /ram)
// must behave identically.
async function checkSymlinks(
  ws: Workspace,
  dst: string,
  label: string,
): Promise<void> {
  await run(ws, `ln -s ${dst}/copied/a.txt /ram/xl.txt`);
  let [out, , code] = await run(ws, "cat /ram/xl.txt");
  check(`${label}: cat through cross-mount link`, out === "aaa\n");
  [out] = await run(ws, "grep aaa /ram/xl.txt");
  check(`${label}: grep through cross-mount link`, out.includes("aaa"));
  await run(ws, "printf 'xw\n' >> /ram/xl.txt");
  [out] = await run(ws, `cat ${dst}/copied/a.txt`);
  check(`${label}: append through link lands on target`, out === "aaa\nxw\n");
  await run(ws, `printf 'aaa\n' > ${dst}/copied/a.txt`);
  await run(ws, "cp /ram/xl.txt /ram/xl_copy.txt");
  [out] = await run(ws, "cat /ram/xl_copy.txt");
  check(`${label}: cp through link relays bytes`, out === "aaa\n");
  await run(ws, `ln -s /ram/dir/a.txt ${dst}/rl.txt`);
  [out] = await run(ws, `cat ${dst}/rl.txt`);
  check(`${label}: link homed on ${label} reads ram target`, out === "aaa\n");
  await run(ws, `ln -s ${dst}/copied /ram/xdir`);
  [out] = await run(ws, "cat /ram/xdir/sub/b.txt");
  check(`${label}: mid-path dir link across mounts`, out === "bbb\n");
  [out] = await run(ws, "ls /ram/xdir");
  check(`${label}: ls through cross-mount dir link`, out.includes("a.txt"));
  await run(ws, "mv /ram/xl.txt /ram/xl2.txt");
  [out] = await run(ws, "readlink /ram/xl2.txt");
  check(`${label}: mv keeps link target`, out.trim() === `${dst}/copied/a.txt`);
  [, , code] = await run(ws, `rm /ram/xl2.txt ${dst}/rl.txt /ram/xdir`);
  check(`${label}: rm links exits 0`, code === 0);
  [out] = await run(ws, `cat ${dst}/copied/a.txt`);
  check(`${label}: target intact after rm links`, out === "aaa\n");
  await run(ws, "rm /ram/xl_copy.txt");
}

// Reads through a link must share the target's cache entry: warming via the
// link keys the cache under the REAL path, so a direct read of the target
// serves the same cached bytes after an out-of-band mutation.
async function statOf(ws: Workspace, path: string): Promise<FileStat> {
  return (await ws.dispatch("stat", path)) as FileStat;
}

async function checkMetadata(
  ws: Workspace,
  dst: string,
  label: string,
): Promise<void> {
  // setattr is resolve-then-act: chmod/chown/touch on a dst-homed file,
  // directly and through links homed on another mount, must land on the
  // target mount (natively or in the namespace overlay) and read back
  // through dispatch-stat identically.
  await run(ws, `printf 'mmm\n' > ${dst}/copied/m.txt`);
  await run(
    ws,
    `chmod 601 ${dst}/copied/m.txt && chown 500:dev ${dst}/copied/m.txt` +
      ` && touch -t 202601021530 ${dst}/copied/m.txt`,
  );
  let st = await statOf(ws, `${dst}/copied/m.txt`);
  check(`${label}: chmod lands on dst mount`, st.mode === 0o601);
  check(
    `${label}: chown lands on dst mount`,
    st.uid === 500 && st.gid === "dev",
  );
  check(
    `${label}: touch stamps dst mtime`,
    (st.modified ?? "").startsWith("2026-01-02T15:30"),
  );
  await run(ws, `ln -s ${dst}/copied/m.txt /ram/ml.txt`);
  await run(ws, "chmod 640 /ram/ml.txt && touch -t 202603041200 /ram/ml.txt");
  st = await statOf(ws, `${dst}/copied/m.txt`);
  check(
    `${label}: chmod through cross-mount link hits target`,
    st.mode === 0o640,
  );
  check(
    `${label}: touch through cross-mount link hits target`,
    (st.modified ?? "").startsWith("2026-03-04T12:00"),
  );
  await run(ws, "touch -h -t 202601010000 /ram/ml.txt");
  st = await statOf(ws, `${dst}/copied/m.txt`);
  check(
    `${label}: touch -h writes link node, target untouched`,
    (st.modified ?? "").startsWith("2026-03-04T12:00"),
  );
  await run(ws, `ln -s ${dst}/copied /ram/mdir`);
  await run(ws, "touch -t 202601021530 /ram/mdir/created.txt");
  const [out] = await run(ws, `ls ${dst}/copied`);
  check(
    `${label}: touch creates through cross-mount dir link`,
    out.includes("created.txt"),
  );
  await run(
    ws,
    `rm /ram/ml.txt /ram/mdir ${dst}/copied/m.txt ${dst}/copied/created.txt`,
  );
}

async function checkSymlinkCache(
  ws: Workspace,
  client: S3Client,
  label: string,
): Promise<void> {
  await putObject(client, "lcache/y.txt", "link-v1\n");
  await run(ws, "ln -s /s3/lcache/y.txt /ram/cl.txt");
  let [out] = await run(ws, "cat /ram/cl.txt");
  check(`${label}: warm via link reads v1`, out === "link-v1\n");
  await putObject(client, "lcache/y.txt", "link-v2\n");
  [out] = await run(ws, "cat /s3/lcache/y.txt");
  check(`${label}: direct read hits cache warmed via link`, out === "link-v1\n");
  [out] = await run(ws, "cat /ram/cl.txt");
  check(`${label}: link read serves cached target bytes`, out === "link-v1\n");
  await run(ws, "rm /ram/cl.txt");
}

// A cross-mount read relays through the dispatcher; that relayed path must
// serve warm bytes from the file cache, not re-fetch the backend. Warm the S3
// object with a single-mount cat, mutate it out-of-band via the SDK, then
// exercise the whole read family with the cached operand on /s3 and a live
// operand on /ram. Under LAZY the cached v1 (keepme/mid/last) must win for
// every command; a relayed path that skipped the cache would fetch v2 (nomatch)
// and these checks would fail. wc discriminates on line count (cached 3 vs v2's
// 1) and grep on a v1-only token.
async function checkCrossMountCache(
  ws: Workspace,
  client: S3Client,
  label: string,
): Promise<void> {
  await putObject(client, "cache/x.txt", "keepme\nmid\nlast\n");
  let [out] = await run(ws, "cat /s3/cache/x.txt");
  check(`${label}: warm read caches v1`, out === "keepme\nmid\nlast\n");
  await putObject(client, "cache/x.txt", "nomatch\n");
  const src = "/ram/dir/a.txt";
  const x = "/s3/cache/x.txt";
  [out] = await run(ws, `cat ${src} ${x}`);
  check(
    `${label}: cross cat serves cached`,
    out === "aaa\nkeepme\nmid\nlast\n",
  );
  [out] = await run(ws, `head -n 1 ${src} ${x}`);
  check(
    `${label}: cross head serves cached`,
    out.includes("keepme") && !out.includes("nomatch"),
  );
  [out] = await run(ws, `tail -n 1 ${src} ${x}`);
  check(
    `${label}: cross tail serves cached`,
    out.includes("last") && !out.includes("nomatch"),
  );
  [out] = await run(ws, `wc -l ${src} ${x}`);
  check(`${label}: cross wc serves cached`, out.includes("4 total"));
  [out] = await run(ws, `grep keepme ${src} ${x}`);
  check(`${label}: cross grep serves cached`, out.includes(`${x}:keepme`));
}

// Glob multi-file warm serving on a single remote mount: warm every file under
// glob/, mutate one out-of-band, then run the read family over glob/*.txt. The
// glob expands to both files; each must serve its cached bytes (a.txt's stale
// v1, not v2). a.txt's v2 grows to two lines so wc and the line-shape commands
// discriminate cache from backend; grep keys on a v1-only token.
async function checkGlobCache(
  ws: Workspace,
  client: S3Client,
  label: string,
): Promise<void> {
  await putObject(client, "glob/a.txt", "alpha-v1\n");
  await putObject(client, "glob/b.txt", "bravo-v1\n");
  await run(ws, "cat /s3/glob/a.txt /s3/glob/b.txt");
  await putObject(client, "glob/a.txt", "alpha-v2\nEXTRA\n");
  const g = "/s3/glob/*.txt";
  let [out] = await run(ws, `head -n 1 ${g}`);
  check(
    `${label}: glob head serves cached`,
    out.includes("alpha-v1") && !out.includes("alpha-v2"),
  );
  [out] = await run(ws, `tail -n 1 ${g}`);
  check(
    `${label}: glob tail serves cached`,
    out.includes("alpha-v1") && !out.includes("EXTRA"),
  );
  [out] = await run(ws, `wc -l ${g}`);
  check(
    `${label}: glob wc serves cached`,
    out.includes("2 total") && !out.includes("3 total"),
  );
  [out] = await run(ws, `grep alpha-v1 ${g}`);
  check(
    `${label}: glob grep serves cached`,
    out.includes("/s3/glob/a.txt:alpha-v1"),
  );
}

async function exercise(
  ws: Workspace,
  dst: string,
  label: string,
  expectDirs: boolean,
): Promise<void> {
  process.stdout.write(`===== ram -> ${label} =====\n`);
  await checkRecursive(ws, dst, label, expectDirs);
  await checkCdCrossMount(ws, dst, label);
  await checkReadFamily(ws, dst, label);
  await checkPartialRead(ws, dst, label);
  await checkCompare(ws, dst, label);
  await checkNoClobber(ws, dst, label);
  await checkOmitDirectory(ws, dst, label);
  await checkMove(ws, dst, label);
  await checkSymlinks(ws, dst, label);
  await checkMetadata(ws, dst, label);
}

async function main(): Promise<void> {
  const client = sdkClient();
  try {
    await client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists")
      throw err;
  }

  const mounts: Record<string, RAMResource | S3Resource | RedisResource> = {
    "/ram": new RAMResource(),
    "/ram2": new RAMResource(),
    "/s3": new S3Resource({
      bucket: S3_BUCKET,
      region: REGION,
      endpoint: ENDPOINT,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      forcePathStyle: true,
    }),
  };
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const prefix = `mirage-integ-cross-${String(process.pid)}-${String(Date.now())}/`;
    mounts["/redis"] = new RedisResource({ url: redisUrl, keyPrefix: prefix });
  }

  const ws = new Workspace(mounts, { mode: MountMode.WRITE });
  try {
    await seedTree(ws, "/ram");
    await checkPartialRead(ws, "/ram", "ram-single");
    await exercise(ws, "/ram2", "ram", true);
    if (redisUrl) await exercise(ws, "/redis", "redis", true);
    else process.stdout.write("SKIP redis (REDIS_URL unset)\n");
    await exercise(ws, "/s3", "s3", false);
    await checkCrossMountCache(ws, client, "s3");
    await checkGlobCache(ws, client, "s3");
    await checkSymlinkCache(ws, client, "s3");
  } finally {
    await ws.close();
    client.destroy();
  }

  if (fail) {
    process.stdout.write(`\ncross commands FAILED (${fail} checks)\n`);
    process.exit(1);
  }
  process.stdout.write("\ncross commands OK\n");
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
