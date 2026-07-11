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
from mirage.resource.langfuse import LangfuseConfig, LangfuseResource

load_dotenv(".env.development")

config = LangfuseConfig(
    public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
    secret_key=os.environ["LANGFUSE_SECRET_KEY"],
    host=os.environ["LANGFUSE_HOST"],
    default_trace_limit=20,
)
resource = LangfuseResource(config=config)


async def _run(ws, cmd):
    print(f"\n>>> {cmd}")
    r = await ws.execute(cmd)
    out = (await r.stdout_str()).strip()
    err = await r.stderr_str()
    if out:
        for line in out.splitlines()[:10]:
            print(f"  {line[:120]}")
        total = len(out.splitlines())
        if total > 10:
            print(f"  ... ({total} lines total)")
    if err:
        print(f"  [stderr] {err.strip()[:120]}")
    if not out and not err:
        print(f"  (empty, exit={r.exit_code})")
    return r


async def _timed(ws, cmd):
    start = time.perf_counter()
    out = await (await ws.execute(cmd)).stdout_str()
    return (time.perf_counter() - start) * 1000, out


async def main():
    ws = Workspace({"/langfuse": resource}, mode=MountMode.READ)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /langfuse/__nf_missing__.txt",
                "head /langfuse/__nf_missing__.txt",
                "stat /langfuse/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=" * 60)
    print("LS across all directories")
    print("=" * 60)

    await _run(ws, "ls /langfuse/")
    await _run(ws, "ls /langfuse/traces/")
    await _run(ws, "ls /langfuse/sessions/")
    await _run(ws, "ls /langfuse/prompts/")
    await _run(ws, "ls /langfuse/datasets/")

    print("\n" + "=" * 60)
    print("CAT across different resource types")
    print("=" * 60)

    r = await ws.execute("ls /langfuse/traces/")
    traces_out = (await r.stdout_str()).strip()
    trace_files = [f for f in traces_out.splitlines() if f.strip()]
    if trace_files:
        tp = f"/langfuse/traces/{trace_files[0].strip()}"
        await _run(ws, f'cat "{tp}" | head -n 5')
    else:
        print("  no traces found, skipping cat trace")

    await _run(ws, 'cat "/langfuse/prompts/summarize/1.json"')
    await _run(ws, 'cat "/langfuse/datasets/qa-eval/items.jsonl"')

    print("\n" + "=" * 60)
    print("GREP across different scopes")
    print("=" * 60)

    await _run(ws, 'grep "chat" "/langfuse/traces/"')

    await _run(ws, 'grep "support" "/langfuse/traces/"')

    await _run(ws, 'grep "chat-session" "/langfuse/sessions/"')

    await _run(ws, 'grep "summarize" "/langfuse/prompts/"')

    await _run(ws, 'grep "qa" "/langfuse/datasets/"')

    if trace_files:
        tp = f"/langfuse/traces/{trace_files[0].strip()}"
        await _run(ws, f'grep "name" "{tp}"')

    print("\n" + "=" * 60)
    print("JQ across different resource types")
    print("=" * 60)

    if trace_files:
        tp = f"/langfuse/traces/{trace_files[0].strip()}"
        await _run(ws, f'jq ".name" "{tp}"')
        await _run(ws, f'jq ".session_id" "{tp}"')
        await _run(ws, f'jq ".input" "{tp}"')

    await _run(
        ws,
        'jq ".prompt" "/langfuse/prompts/summarize/1.json"',
    )
    await _run(
        ws,
        'jq ".config" "/langfuse/prompts/classify/1.json"',
    )

    await _run(
        ws,
        'jq ".[] | .input" '
        '"/langfuse/datasets/qa-eval/items.jsonl"',
    )
    await _run(
        ws,
        'jq -r ".[] | .expected_output.answer" '
        '"/langfuse/datasets/qa-eval/items.jsonl"',
    )

    print("\n" + "=" * 60)
    print("SESSION browsing")
    print("=" * 60)

    await _run(ws, "ls /langfuse/sessions/chat-session-001/")

    r = await ws.execute("ls /langfuse/sessions/chat-session-001/", )
    session_traces = (await r.stdout_str()).strip().splitlines()
    if session_traces:
        st = session_traces[0].strip()
        sp = f"/langfuse/sessions/chat-session-001/{st}"
        await _run(ws, f'cat "{sp}" | head -n 3')

    print("\n" + "=" * 60)
    print("PROMPTS and DATASETS detail")
    print("=" * 60)

    await _run(ws, "ls /langfuse/prompts/summarize/")
    await _run(ws, "ls /langfuse/datasets/qa-eval/")
    await _run(ws, "ls /langfuse/datasets/qa-eval/runs/")

    await _run(ws, 'stat "/langfuse/prompts/summarize"')
    await _run(ws, 'stat "/langfuse/datasets/qa-eval"')

    print("\n" + "=" * 60)
    print("TREE, FIND, NAVIGATION")
    print("=" * 60)

    await _run(ws, "tree -L 2 /langfuse/")
    await _run(
        ws,
        'find "/langfuse/prompts/" -name "*.json"',
    )

    await ws.execute('cd "/langfuse/prompts"')
    await _run(ws, "pwd")
    await _run(ws, "ls")

    print("\n" + "=" * 60)
    print("CACHING: warm reads served from cache (no backend fetch)")
    print("=" * 60)
    r = await ws.execute('find "/langfuse/prompts/" -name "*.json"')
    prompt_files = (await r.stdout_str()).strip().splitlines()
    if prompt_files:
        cache_file = prompt_files[0].strip()
        cold_ms, body = await _timed(ws, f'cat "{cache_file}"')
        warm_ms, _ = await _timed(ws, f'cat "{cache_file}"')
        grep_ms, _ = await _timed(ws, f'grep . "{cache_file}"')
        head_ms, _ = await _timed(ws, f'head -n 1 "{cache_file}"')
        tail_ms, _ = await _timed(ws, f'tail -n 1 "{cache_file}"')
        wc_ms, _ = await _timed(ws, f'wc -l "{cache_file}"')
        print(f"  file={cache_file} size={len(body)}B")
        print(
            f"  cold cat={cold_ms:.0f}ms  warm cat={warm_ms:.0f}ms  "
            f"grep={grep_ms:.0f}ms head={head_ms:.0f}ms tail={tail_ms:.0f}ms "
            f"wc={wc_ms:.0f}ms")
        print(f"  served_from_cache={warm_ms < cold_ms / 5} "
              f"(warm speedup {cold_ms / max(warm_ms, 0.001):.0f}x)")

    print("\n" + "=" * 60)
    print("GLOB: mid-path patterns walk segment by segment")
    print("=" * 60)
    r = await ws.execute("echo /langfuse/prom*/*")
    out = (await r.stdout_str()).strip()
    print(f"  echo /langfuse/prom*/* -> {out[:200]}")
    assert "/langfuse/prompts/" in out, "mid-path glob did not expand"

    # A glob that matches nothing stays the literal word, so the
    # command reports it like GNU coreutils.
    r = await ws.execute("cat /langfuse/zz-none-*/x.json")
    err = (await r.stderr_str()).strip()
    print(f"  cat /langfuse/zz-none-*/x.json -> exit={r.exit_code} "
          f"{err[:120]}")
    assert r.exit_code == 1 and "zz-none-*" in err


if __name__ == "__main__":
    asyncio.run(main())
