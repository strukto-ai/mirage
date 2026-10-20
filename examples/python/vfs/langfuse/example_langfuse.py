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
from mirage.types import PathSpec
from mirage.vfs.langfuse import LangfuseConfig, LangfuseVFS

load_dotenv(".env.development")


def build_config() -> LangfuseConfig:
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY", "")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY", "")
    if not public_key or not secret_key:
        raise RuntimeError(
            "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY env vars are required"
        )
    host = os.environ.get("LANGFUSE_HOST", "")
    return LangfuseConfig(
        public_key=public_key,
        secret_key=secret_key,
        **({"host": host} if host else {}),
    )


async def run(ws: Workspace, cmd: str) -> str:
    print(f"$ {cmd}")
    r = await ws.shell(cmd)
    err = await r.stderr_str()
    if r.exit_code != 0 and err:
        print(f"  STDERR: {err[:200]}")
    out = (await r.stdout_str()).rstrip()
    if out:
        for line in out.split("\n")[:10]:
            print(f"  {line[:200]}")
    return out


async def timed(ws: Workspace, cmd: str) -> tuple[float, str]:
    start = time.perf_counter()
    out = await (await ws.shell(cmd)).stdout_str()
    return (time.perf_counter() - start) * 1000, out


async def main() -> None:
    ws = Workspace(
        {"/langfuse": LangfuseVFS(build_config())}, mode=MountMode.READ
    )
    try:
        print("=== ls /langfuse/ ===")
        await run(ws, "ls /langfuse/")
        for scope in ("traces", "sessions", "prompts", "datasets"):
            print(f"\n=== ls /langfuse/{scope}/ ===")
            await run(ws, f"ls /langfuse/{scope}/ | head -n 5")

        print("\n=== first trace ===")
        t0 = (await run(ws, "ls /langfuse/traces/ | head -n 1")).strip()
        if t0:
            trace_path = f"/langfuse/traces/{t0}"
            await run(ws, f'cat "{trace_path}" | head -n 5')
            await run(ws, f'jq ".name" "{trace_path}"')
            await run(ws, f'jq -r ".id" "{trace_path}"')
            await run(ws, f'wc "{trace_path}"')
            await run(ws, f'stat "{trace_path}"')

        # chmod/chown/touch never hit the Langfuse API: attrs land in the
        # workspace namespace (durable, snapshot-captured) and merge into
        # dispatch-level stat.
        print("=== metadata overlay on /langfuse/prompts/summarize ===")
        meta_res = await ws.shell(
            'chmod 640 "/langfuse/prompts/summarize"'
            ' && chown 500:dev "/langfuse/prompts/summarize"'
            ' && touch -t 202601021530 "/langfuse/prompts/summarize"'
        )
        print(f"  chmod/chown/touch exit={meta_res.exit_code}")
        meta_st, _ = await ws.dispatch(
            "stat", PathSpec.from_str_path("/langfuse/prompts/summarize")
        )
        meta_mode = oct(meta_st.mode)[2:] if meta_st.mode is not None else "-"
        print(
            f"  dispatch stat: mode={meta_mode} uid={meta_st.uid} "
            f"gid={meta_st.gid} mtime={meta_st.modified}"
        )

        print("\n=== grep -r per scope ===")
        await run(ws, 'grep -r "a" /langfuse/traces/ | head -n 3')
        await run(ws, 'grep -r "a" /langfuse/sessions/ | head -n 3')
        await run(ws, 'grep -r "a" /langfuse/prompts/ | head -n 3')

        print("\n=== rg across prompts ===")
        await run(ws, 'rg -l "name" /langfuse/prompts/ | head -n 3')

        print("\n=== datasets ===")
        d0 = (
            (await run(ws, "ls /langfuse/datasets/ | head -n 1"))
            .strip()
            .rstrip("/")
        )
        if d0:
            items_path = f"/langfuse/datasets/{d0}/items.jsonl"
            await run(ws, f'head -n 2 "{items_path}"')
            await run(ws, f'jq ".id" "{items_path}" | head -n 3')

        print("\n=== tree -L 2 /langfuse/ ===")
        await run(ws, "tree -L 2 /langfuse/ | head -n 20")

        print("\n" + "=" * 60)
        print("CACHING: warm reads served from cache (no backend fetch)")
        print("=" * 60)
        found = await run(ws, 'find "/langfuse/prompts/" -name "*.json"')
        prompt_files = found.split("\n") if found else []
        if prompt_files:
            cache_file = prompt_files[0].strip()
            cold_ms, body = await timed(ws, f'cat "{cache_file}"')
            warm_ms, _ = await timed(ws, f'cat "{cache_file}"')
            grep_ms, _ = await timed(ws, f'grep . "{cache_file}"')
            head_ms, _ = await timed(ws, f'head -n 1 "{cache_file}"')
            tail_ms, _ = await timed(ws, f'tail -n 1 "{cache_file}"')
            wc_ms, _ = await timed(ws, f'wc -l "{cache_file}"')
            print(f"  file={cache_file} size={len(body)}B")
            print(
                f"  cold cat={cold_ms:.0f}ms  warm cat={warm_ms:.0f}ms  "
                f"grep={grep_ms:.0f}ms head={head_ms:.0f}ms "
                f"tail={tail_ms:.0f}ms wc={wc_ms:.0f}ms"
            )
            print(
                f"  served_from_cache={warm_ms < cold_ms / 5} "
                f"(warm speedup {cold_ms / max(warm_ms, 0.001):.0f}x)"
            )

        print("\n" + "=" * 60)
        print("GLOB: mid-path patterns walk segment by segment")
        print("=" * 60)
        r = await ws.shell("echo /langfuse/prom*/*")
        glob_out = (await r.stdout_str()).strip()
        print(f"  echo /langfuse/prom*/* -> {glob_out[:200]}")
        if "/langfuse/prompts/" not in glob_out:
            raise RuntimeError("regression: mid-path glob did not expand")

        # A glob that matches nothing stays the literal word, so the
        # command reports it like GNU coreutils.
        r = await ws.shell("cat /langfuse/zz-none-*/x.json")
        lit_err = (await r.stderr_str()).strip()
        print(
            f"  cat /langfuse/zz-none-*/x.json -> exit={r.exit_code} "
            f"{lit_err[:120]}"
        )
        if r.exit_code != 1 or "zz-none-*" not in lit_err:
            raise RuntimeError(
                "regression: zero-match glob did not keep the literal"
            )
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
