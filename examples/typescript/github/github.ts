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

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { GitHubResource, MountMode, Workspace } from "@struktoai/mirage-node";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__HERE, "../../../.env.development") });

const TOKEN = process.env.GITHUB_TOKEN;
if (TOKEN === undefined || TOKEN === "") {
  throw new Error("GITHUB_TOKEN env var is required");
}

async function show(ws: Workspace, cmd: string): Promise<void> {
  try {
    const r = await ws.execute(cmd);
    console.log(r.stdoutText);
    if (r.stderrText !== "") process.stderr.write(r.stderrText);
  } catch (err) {
    process.stderr.write(
      `# ${cmd} → ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function header(
  ws: Workspace,
  label: string,
  cmd: string,
): Promise<void> {
  console.log(`=== ${label} ===`);
  try {
    const r = await ws.execute(cmd);
    console.log(r.stdoutText);
    if (r.stderrText !== "") process.stderr.write(r.stderrText);
  } catch (err) {
    process.stderr.write(
      `# ${cmd} → ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function timed(ws: Workspace, cmd: string): Promise<[number, string]> {
  const start = performance.now();
  const r = await ws.execute(cmd);
  return [performance.now() - start, r.stdoutText];
}

async function narrowCase(
  ws: Workspace,
  label: string,
  cmd: string,
): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const [ms, out] = await timed(ws, cmd);
  const lines = out.trim() === "" ? [] : out.trim().split("\n");
  console.log(`  ${ms.toFixed(0)}ms  results: ${String(lines.length)}`);
  for (const line of lines.slice(0, 3)) console.log(`  ${line.slice(0, 150)}`);
}

async function main(): Promise<void> {
  const resource = await GitHubResource.create({
    token: TOKEN!,
    owner: "strukto-ai",
    repo: "mirage-internal",
    ref: "main",
  });
  const ws = new Workspace({ "/github": resource }, { mode: MountMode.READ });

  await show(ws, "ls /github");
  await show(ws, "ls /github/python/mirage/core");
  await show(ws, "cat /github/python/pyproject.toml");
  await show(ws, "grep 'BaseResource' /github/python/mirage/resource/base.py");
  await show(ws, "grep 'import' /github/python/mirage/*");
  await show(ws, "grep 'import' /github/python/mirage/core/s3/*.py");
  await show(ws, "grep -r 'async def' /github/python/mirage/core/s3/");
  await show(ws, "find /github/mirage -name '*.py'");
  await show(ws, "stat /github/python/mirage/types.py");
  await show(ws, "du /github/python/mirage/core");

  await header(ws, "head -n 5", "head -n 5 /github/python/pyproject.toml");
  await header(ws, "tail -n 3", "tail -n 3 /github/python/pyproject.toml");
  await header(ws, "wc", "wc /github/python/pyproject.toml");
  await header(ws, "wc -l", "wc -l /github/python/pyproject.toml");
  await header(
    ws,
    "grep -n (line numbers)",
    "grep -n 'def ' /github/python/mirage/types.py",
  );
  await header(
    ws,
    "grep -c (count)",
    "grep -c 'import' /github/python/mirage/types.py",
  );
  await header(
    ws,
    "grep -i (case insensitive)",
    "grep -i 'filestat' /github/python/mirage/types.py",
  );
  await header(
    ws,
    "grep -l (files with matches)",
    "grep -rl 'BaseResource' /github/python/mirage/resource/",
  );

  for (const [label, cmd] of [
    [
      "grep -r mirage /github/python/mirage/core/s3/ (narrows via search.code)",
      "grep -r mirage /github/python/mirage/core/s3/",
    ],
    [
      "grep -r FileType /github/python/mirage/core/s3/ (recursive scope)",
      "grep -r FileType /github/python/mirage/core/s3/",
    ],
    [
      "rg mirage /github/python/mirage/core/s3/ (rg recursive scope)",
      "rg mirage /github/python/mirage/core/s3/",
    ],
    [
      "grep -r GitHubAccessor /github/ (repo-root search narrowing)",
      "grep -r GitHubAccessor /github/ | sort",
    ],
  ] as const) {
    console.log(`\n=== ${label} ===`);
    let r;
    try {
      r = await ws.execute(cmd);
    } catch (err) {
      console.log(
        `  error: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const out = r.stdoutText.trim();
    const lines = out === "" ? [] : out.split("\n");
    console.log(
      `  exit=${String(r.exitCode)} matches: ${String(lines.length)}`,
    );
    if (r.stderrText.trim() !== "")
      console.log(`  stderr: ${r.stderrText.trim().slice(0, 200)}`);
    for (const line of lines.slice(0, 3))
      console.log(`  ${line.slice(0, 150)}`);
  }

  // subdir + regex narrowing + -l short-circuit (issue #404). A large subdir
  // (>100 files) is what makes the per-file fallback slow; these narrow via
  // GitHub code search instead of fetching each file.
  const bigDir = "/github/python/mirage/";
  await narrowCase(
    ws,
    `grep -rln BaseResource ${bigDir} (subdir narrowing, -l short-circuit)`,
    `grep -rln BaseResource ${bigDir}`,
  );
  await narrowCase(
    ws,
    `grep -rn 'async def .*self' ${bigDir} (regex narrows via required literal 'async def ')`,
    `grep -rn 'async def .*self' ${bigDir}`,
  );
  await narrowCase(
    ws,
    `rg -l GitHubAccessor ${bigDir} (rg subdir narrowing, -l short-circuit)`,
    `rg -l GitHubAccessor ${bigDir}`,
  );
  await narrowCase(
    ws,
    `rg -l --glob '*.py' GitHubAccessor ${bigDir} (file filter applied to narrowed set)`,
    `rg -l --glob '*.py' GitHubAccessor ${bigDir}`,
  );
  await narrowCase(
    ws,
    `rg -l --type py GitHubAccessor ${bigDir} (--type filter applied to narrowed set)`,
    `rg -l --type py GitHubAccessor ${bigDir}`,
  );

  await header(ws, "find -type d", "find /github/python/mirage/core -type d");
  await header(ws, "ls -l", "ls -l /github/python/mirage/core/s3/");
  await header(
    ws,
    "find | sort",
    "find /github/python/mirage/core/s3 -name '*.py' | sort",
  );
  await header(
    ws,
    "diff",
    "diff /github/python/mirage/core/s3/stat.py /github/python/mirage/core/s3/read.py",
  );
  await header(
    ws,
    "cat + pipe to wc",
    "cat /github/python/mirage/types.py | wc -l",
  );
  await header(
    ws,
    "grep + cut",
    "grep -n 'class ' /github/python/mirage/types.py | cut -d: -f1",
  );
  await header(
    ws,
    "grep + awk",
    "grep 'class ' /github/python/mirage/types.py | awk '{print $2}'",
  );
  await header(ws, "md5", "md5 /github/python/mirage/types.py");
  await header(ws, "tree", "tree /github/python/mirage/core/s3/");
  await header(ws, "find workspace.py", "find /github -name 'workspace.py'");
  await header(
    ws,
    "wc -l (lines)",
    "wc -l /github/python/mirage/workspace/workspace.py",
  );
  await header(
    ws,
    "wc -w (words)",
    "wc -w /github/python/mirage/workspace/workspace.py",
  );
  await header(ws, "jq", 'jq ".name" /github/python/pyproject.toml');
  await header(ws, "nl", "nl /github/python/mirage/types.py");
  await header(ws, "tr", "cat /github/python/mirage/types.py | tr 'a-z' 'A-Z'");
  await header(
    ws,
    "sort | uniq",
    "grep 'import' /github/python/mirage/types.py | sort | uniq",
  );
  await header(
    ws,
    "uniq (file path, streams via github read)",
    "uniq /github/python/mirage/types.py",
  );
  await header(ws, "sha256sum", "sha256sum /github/python/mirage/types.py");
  await header(ws, "file", "file /github/python/mirage/types.py");
  await header(
    ws,
    "basename",
    "basename /github/python/mirage/core/s3/read.py",
  );
  await header(ws, "dirname", "dirname /github/python/mirage/core/s3/read.py");
  await header(
    ws,
    "realpath",
    "realpath /github/python/mirage/../mirage/types.py",
  );
  await header(
    ws,
    "sed -n (line range)",
    "sed -n '1,3p' /github/python/mirage/types.py",
  );
  await header(
    ws,
    "sed s/// (file)",
    "sed 's/import/IMPORT/' /github/python/mirage/core/s3/read.py",
  );
  await header(
    ws,
    "awk (file)",
    "awk '{print $1}' /github/python/mirage/core/s3/read.py",
  );
  await header(
    ws,
    "cut -c (file)",
    "cut -c1-10 /github/python/mirage/types.py",
  );

  console.log("=== grep dir operands (POSIX warn) ===");
  {
    const r = await ws.execute("grep 'import' /github/python/mirage/*");
    const out = r.stdoutText.trim();
    const err = r.stderrText.trim();
    const matches = out === "" ? 0 : out.split("\n").length;
    console.log(`  exit=${String(r.exitCode)} matches: ${String(matches)}`);
    for (const line of err.split("\n").slice(0, 3)) console.log(`  ${line}`);
    console.log();
  }

  await header(
    ws,
    "diff -u",
    "diff -u /github/python/mirage/core/s3/stat.py /github/python/mirage/core/s3/read.py",
  );
  await header(ws, "tree -L", "tree -L 2 /github/python/mirage/");
  await header(ws, "rg", "rg 'BaseResource' /github/python/mirage/resource/");

  console.log(
    "=== caching: a warm read is served from cache (no backend fetch) ===",
  );
  const cacheFile = "/github/python/mirage/workspace/workspace.py";
  const [coldMs, body] = await timed(ws, `cat ${cacheFile}`);
  const [warmMs] = await timed(ws, `cat ${cacheFile}`);
  const [grepMs] = await timed(ws, `grep 'def ' ${cacheFile}`);
  const [headMs] = await timed(ws, `head -n 5 ${cacheFile}`);
  const [tailMs] = await timed(ws, `tail -n 5 ${cacheFile}`);
  const [wcMs] = await timed(ws, `wc -l ${cacheFile}`);
  console.log(`  file=${cacheFile} size=${String(body.length)}B`);
  console.log(
    `  cold cat=${coldMs.toFixed(0)}ms  warm cat=${warmMs.toFixed(0)}ms  ` +
      `grep=${grepMs.toFixed(0)}ms head=${headMs.toFixed(0)}ms tail=${tailMs.toFixed(0)}ms ` +
      `wc=${wcMs.toFixed(0)}ms`,
  );
  console.log(
    `  served_from_cache=${String(warmMs < coldMs / 5)} ` +
      `(warm speedup ${(coldMs / Math.max(warmMs, 0.001)).toFixed(0)}x)`,
  );

  await ws.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
