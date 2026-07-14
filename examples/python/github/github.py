# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
import os
import time

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.github import GitHubConfig, GitHubResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = GitHubConfig(token=os.environ["GITHUB_TOKEN"])


async def _timed(ws, cmd):
    start = time.perf_counter()
    out = await (await ws.execute(cmd)).stdout_str()
    return (time.perf_counter() - start) * 1000, out


async def main() -> None:
    resource = GitHubResource(
        config=config,
        owner="strukto-ai",
        repo="mirage",
        ref="main",
    )
    ws = Workspace({"/github": resource}, mode=MountMode.READ)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /github/__nf_missing__.txt",
                "head /github/__nf_missing__.txt",
                "stat /github/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    r = await ws.execute("ls /github")
    print(await r.stdout_str())

    r = await ws.execute("ls /github/python/mirage/core")
    print(await r.stdout_str())

    r = await ws.execute("cat /github/python/pyproject.toml")
    print(await r.stdout_str())

    r = await ws.execute(
        "grep 'BaseResource' /github/python/mirage/resource/base.py")
    print(await r.stdout_str())

    r = await ws.execute("grep 'import' /github/python/mirage/*")
    print(await r.stdout_str())

    r = await ws.execute("grep 'import' /github/python/mirage/core/s3/*.py")
    print(await r.stdout_str())

    r = await ws.execute("grep -r 'async def' /github/python/mirage/core/s3/")
    print(await r.stdout_str())

    r = await ws.execute("find /github/mirage -name '*.py'")
    print(await r.stdout_str())

    r = await ws.execute("stat /github/python/mirage/types.py")
    print(await r.stdout_str())

    # chmod/chown/touch never hit the GitHub API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /github/python/mirage/types.py ===")
    meta_res = await ws.execute(
        'chmod 640 "/github/python/mirage/types.py"'
        ' && chown 500:dev "/github/python/mirage/types.py"'
        ' && touch -t 202601021530 "/github/python/mirage/types.py"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path("/github/python/mirage/types.py"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    r = await ws.execute("du /github/python/mirage/core")
    print(await r.stdout_str())

    print("=== head -n 5 ===")
    r = await ws.execute("head -n 5 /github/python/pyproject.toml")
    print(await r.stdout_str())

    print("=== tail -n 3 ===")
    r = await ws.execute("tail -n 3 /github/python/pyproject.toml")
    print(await r.stdout_str())

    print("=== wc ===")
    r = await ws.execute("wc /github/python/pyproject.toml")
    print(await r.stdout_str())

    print("=== wc -l ===")
    r = await ws.execute("wc -l /github/python/pyproject.toml")
    print(await r.stdout_str())

    print("=== grep -n (line numbers) ===")
    r = await ws.execute("grep -n 'def ' /github/python/mirage/types.py")
    print(await r.stdout_str())

    print("=== grep -c (count) ===")
    r = await ws.execute("grep -c 'import' /github/python/mirage/types.py")
    print(await r.stdout_str())

    print("=== grep -i (case insensitive) ===")
    r = await ws.execute("grep -i 'filestat' /github/python/mirage/types.py")
    print(await r.stdout_str())

    print("=== grep -l (files with matches) ===")
    r = await ws.execute(
        "grep -rl 'BaseResource' /github/python/mirage/resource/")
    print(await r.stdout_str())

    # ── native search dispatch (GitHub code search narrows files) ──
    s3_dir = "/github/python/mirage/core/s3/"
    for label, cmd in [
        (f"grep -r mirage {s3_dir} (narrows via search.code)",
         f"grep -r mirage {s3_dir}"),
        (f"grep -r FileType {s3_dir} (recursive scope)",
         f"grep -r FileType {s3_dir}"),
        (f"rg mirage {s3_dir} (rg recursive scope)", f"rg mirage {s3_dir}"),
        ("grep -r GitHubAccessor /github/ (repo-root search narrowing)",
         "grep -r GitHubAccessor /github/ | sort"),
    ]:
        print(f"\n=== {label} ===")
        r = await ws.execute(cmd)
        out = (await r.stdout_str()).strip()
        err = (await r.stderr_str()).strip()
        lines = out.splitlines() if out else []
        print(f"  exit={r.exit_code} matches: {len(lines)}")
        if err:
            print(f"  stderr: {err[:200]}")
        for line in lines[:3]:
            print(f"  {line[:150]}")

    # ── subdir + regex narrowing + -l short-circuit (issue #404) ──
    # A large subdir (>100 files) is what makes the per-file fallback slow;
    # these cases narrow via GitHub code search instead of fetching each file.
    big_dir = "/github/python/mirage/"
    print(f"\n=== grep -rln BaseResource {big_dir} "
          "(subdir narrowing, -l short-circuit) ===")
    ms, out = await _timed(ws, f"grep -rln BaseResource {big_dir}")
    files = out.strip().splitlines() if out.strip() else []
    print(f"  {ms:.0f}ms  files-with-matches: {len(files)}")
    for line in files[:3]:
        print(f"  {line}")

    print(f"\n=== grep -rn 'async def .*self' {big_dir} "
          "(regex narrows via required literal 'async def ') ===")
    ms, out = await _timed(ws, f"grep -rn 'async def .*self' {big_dir}")
    lines = out.strip().splitlines() if out.strip() else []
    print(f"  {ms:.0f}ms  matches: {len(lines)}")
    for line in lines[:3]:
        print(f"  {line[:150]}")

    print(f"\n=== rg -l GitHubAccessor {big_dir} "
          "(rg subdir narrowing, -l short-circuit) ===")
    ms, out = await _timed(ws, f"rg -l GitHubAccessor {big_dir}")
    files = out.strip().splitlines() if out.strip() else []
    print(f"  {ms:.0f}ms  files-with-matches: {len(files)}")
    for line in files[:3]:
        print(f"  {line}")

    print(f"\n=== rg -l --glob '*.py' GitHubAccessor {big_dir} "
          "(file filter applied to narrowed set) ===")
    ms, out = await _timed(ws, f"rg -l --glob '*.py' GitHubAccessor {big_dir}")
    files = out.strip().splitlines() if out.strip() else []
    print(f"  {ms:.0f}ms  files-with-matches: {len(files)}")
    for line in files[:3]:
        print(f"  {line}")

    print(f"\n=== rg -l --type py GitHubAccessor {big_dir} "
          "(--type filter applied to narrowed set) ===")
    ms, out = await _timed(ws, f"rg -l --type py GitHubAccessor {big_dir}")
    files = out.strip().splitlines() if out.strip() else []
    print(f"  {ms:.0f}ms  files-with-matches: {len(files)}")
    for line in files[:3]:
        print(f"  {line}")

    print("=== find -type d ===")
    r = await ws.execute("find /github/python/mirage/core -type d")
    print(await r.stdout_str())

    print("=== ls -l ===")
    r = await ws.execute("ls -l /github/python/mirage/core/s3/")
    print(await r.stdout_str())

    print("=== find | sort ===")
    r = await ws.execute(
        "find /github/python/mirage/core/s3 -name '*.py' | sort")
    print(await r.stdout_str())

    print("=== diff ===")
    r = await ws.execute("diff /github/python/mirage/core/s3/stat.py"
                         " /github/python/mirage/core/s3/read.py")
    print(await r.stdout_str())

    print("=== cat + pipe to wc ===")
    r = await ws.execute("cat /github/python/mirage/types.py | wc -l")
    print(await r.stdout_str())

    print("=== grep + cut ===")
    r = await ws.execute(
        "grep -n 'class ' /github/python/mirage/types.py | cut -d: -f1")
    print(await r.stdout_str())

    print("=== grep + awk ===")
    r = await ws.execute(
        "grep 'class ' /github/python/mirage/types.py | awk '{print $2}'")
    print(await r.stdout_str())

    print("=== md5 ===")
    r = await ws.execute("md5 /github/python/mirage/types.py")
    print(await r.stdout_str())

    print("=== tree ===")
    r = await ws.execute("tree /github/python/mirage/core/s3/")
    print(await r.stdout_str())

    print("=== find workspace.py ===")
    r = await ws.execute("find /github -name 'workspace.py'")
    print(await r.stdout_str())

    print("=== wc -l (lines) ===")
    r = await ws.execute("wc -l /github/python/mirage/workspace/workspace.py")
    print(await r.stdout_str())

    print("=== wc -w (words) ===")
    r = await ws.execute("wc -w /github/python/mirage/workspace/workspace.py")
    print(await r.stdout_str())

    print("=== jq ===")
    r = await ws.execute('jq ".name" /github/python/pyproject.toml')
    print(await r.stdout_str())

    print("=== nl ===")
    r = await ws.execute("nl /github/python/mirage/types.py")
    print(await r.stdout_str())

    print("=== tr ===")
    r = await ws.execute("cat /github/python/mirage/types.py | tr 'a-z' 'A-Z'")
    print(await r.stdout_str())

    print("=== sort | uniq ===")
    r = await ws.execute(
        "grep 'import' /github/python/mirage/types.py | sort | uniq")
    print(await r.stdout_str())

    print("=== uniq (file path, streams via github read) ===")
    r = await ws.execute("uniq /github/python/mirage/types.py")
    print(await r.stdout_str())

    print("=== sha256sum ===")
    r = await ws.execute("sha256sum /github/python/mirage/types.py")
    print(await r.stdout_str())

    print("=== file ===")
    r = await ws.execute("file /github/python/mirage/types.py")
    print(await r.stdout_str())

    print("=== basename ===")
    r = await ws.execute("basename /github/python/mirage/core/s3/read.py")
    print(await r.stdout_str())

    print("=== dirname ===")
    r = await ws.execute("dirname /github/python/mirage/core/s3/read.py")
    print(await r.stdout_str())

    print("=== realpath ===")
    r = await ws.execute("realpath /github/python/mirage/../mirage/types.py")
    print(await r.stdout_str())

    print("=== sed -n (line range) ===")
    r = await ws.execute("sed -n '1,3p' /github/python/mirage/types.py")
    print(await r.stdout_str())

    print("=== sed s/// (file) ===")
    r = await ws.execute(
        "sed 's/import/IMPORT/' /github/python/mirage/core/s3/read.py")
    print(await r.stdout_str())

    print("=== awk (file) ===")
    r = await ws.execute(
        "awk '{print $1}' /github/python/mirage/core/s3/read.py")
    print(await r.stdout_str())

    print("=== cut -c (file) ===")
    r = await ws.execute("cut -c1-10 /github/python/mirage/types.py")
    print(await r.stdout_str())

    print("=== grep dir operands (POSIX warn) ===")
    r = await ws.execute("grep 'import' /github/python/mirage/*")
    out = (await r.stdout_str()).strip()
    err = (await r.stderr_str()).strip()
    print(
        f"  exit={r.exit_code} matches: {len(out.splitlines()) if out else 0}")
    for line in err.splitlines()[:3]:
        print(f"  {line}")
    print()

    print("=== diff -u ===")
    r = await ws.execute("diff -u /github/python/mirage/core/s3/stat.py"
                         " /github/python/mirage/core/s3/read.py")
    print(await r.stdout_str())

    print("=== tree -L ===")
    r = await ws.execute("tree -L 2 /github/python/mirage/")
    print(await r.stdout_str())

    print("=== rg ===")
    r = await ws.execute("rg 'BaseResource' /github/python/mirage/resource/")
    print(await r.stdout_str())

    print(
        "=== caching: a warm read is served from cache (no backend fetch) ===")
    cache_file = "/github/python/mirage/workspace/workspace.py"
    cold_ms, body = await _timed(ws, f"cat {cache_file}")
    warm_ms, _ = await _timed(ws, f"cat {cache_file}")
    grep_ms, _ = await _timed(ws, f"grep 'def ' {cache_file}")
    head_ms, _ = await _timed(ws, f"head -n 5 {cache_file}")
    tail_ms, _ = await _timed(ws, f"tail -n 5 {cache_file}")
    wc_ms, _ = await _timed(ws, f"wc -l {cache_file}")
    print(f"  file={cache_file} size={len(body)}B")
    print(f"  cold cat={cold_ms:.0f}ms  warm cat={warm_ms:.0f}ms  "
          f"grep={grep_ms:.0f}ms head={head_ms:.0f}ms tail={tail_ms:.0f}ms "
          f"wc={wc_ms:.0f}ms")
    print(f"  served_from_cache={warm_ms < cold_ms / 5} "
          f"(warm speedup {cold_ms / max(warm_ms, 0.001):.0f}x)")


if __name__ == "__main__":
    asyncio.run(main())
