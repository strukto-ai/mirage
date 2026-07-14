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
from mirage.resource.hf_models import HfModelsConfig, HfModelsResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = HfModelsConfig(
    repo_id=os.environ.get("HF_MODEL_REPO", "sapientinc/HRM-Text-1B"),
    token=os.environ.get("HF_TOKEN"),
)
resource = HfModelsResource(config)
ws = Workspace({"/m/": resource}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


def show_plan(label: str, dr) -> None:
    print(f"\n--- plan: {label} ---")
    print(f"  network_read: {dr.network_read}  cache_read: {dr.cache_read}")
    print(f"  read_ops: {dr.read_ops}  cache_hits: {dr.cache_hits}  "
          f"precision: {dr.precision}")


async def main():
    print(f"=== mounted {resource.accessor.bucket_uri} at /m/ ===")

    print("\n=== not-found errors show the full virtual path ===")
    for cmd in ("cat /m/__nf_missing__.txt", "head /m/__nf_missing__.txt",
                "stat /m/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    # ── discover structure ──────────────────────────────
    print("\n=== ls /m/ ===")
    r = await ws.execute("ls /m/")
    print(await r.stdout_str())

    print("=== ls -lh /m/ (sizes; weights stay remote) ===")
    r = await ws.execute("ls -lh /m/")
    print(await r.stdout_str())

    print("=== tree /m/ ===")
    r = await ws.execute("tree /m/")
    print(await r.stdout_str())

    # ── stat (root + small + huge file) ─────────────────
    print("\n=== stat /m/config.json ===")
    r = await ws.execute("stat /m/config.json")
    print(f"  {(await r.stdout_str()).strip()}")

    # chmod/chown/touch never hit the Hub API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /m/config.json ===")
    meta_res = await ws.execute('chmod 640 "/m/config.json"'
                                ' && chown 500:dev "/m/config.json"'
                                ' && touch -t 202601021530 "/m/config.json"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat",
                                   PathSpec.from_str_path("/m/config.json"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    print("=== stat /m/model.safetensors (no download) ===")
    r = await ws.execute("stat /m/model.safetensors")
    print(f"  {(await r.stdout_str()).strip()}")

    print("=== stat -c '%s' /m/model.safetensors ===")
    r = await ws.execute("stat -c '%s' /m/model.safetensors")
    print(f"  weights size (bytes): {(await r.stdout_str()).strip()}")

    # ── cat the config (small + fast) ───────────────────
    print("\n=== cat /m/config.json ===")
    r = await ws.execute("cat /m/config.json")
    print(await r.stdout_str())

    print("=== wc -l /m/config.json ===")
    r = await ws.execute("wc -l /m/config.json")
    print(f"  {(await r.stdout_str()).strip()}")

    # ── jq: introspect the architecture ─────────────────
    print("\n=== jq .model_type /m/config.json ===")
    r = await ws.execute("jq .model_type /m/config.json")
    print(f"  {(await r.stdout_str()).strip()}")

    print("=== jq .architectures /m/config.json ===")
    r = await ws.execute("jq .architectures /m/config.json")
    print(f"  {(await r.stdout_str()).strip()}")

    print("=== jq '{hidden_size, num_hidden_layers, num_attention_heads,"
          " vocab_size}' /m/config.json ===")
    r = await ws.execute("jq '{hidden_size, num_hidden_layers,"
                         " num_attention_heads, vocab_size}'"
                         " /m/config.json")
    print(await r.stdout_str())

    # ── tokenizer config ────────────────────────────────
    print("=== cat /m/tokenizer_config.json | jq .pad_token_id ===")
    r = await ws.execute("cat /m/tokenizer_config.json"
                         " | jq .pad_token_id 2>/dev/null"
                         " || echo '(no pad_token_id)'")
    print(f"  {(await r.stdout_str()).strip()}")

    # ── README inspection ───────────────────────────────
    print("\n=== head -n 30 /m/README.md ===")
    r = await ws.execute("head -n 30 /m/README.md")
    print(await r.stdout_str())

    print("=== grep -ic license /m/README.md ===")
    r = await ws.execute("grep -ic license /m/README.md")
    print(f"  matches: {(await r.stdout_str()).strip()}")

    # ── sed: read-transform on the read-only HF mount ───
    print("\n=== sed -n '1,3p' /m/config.json (print first 3 lines) ===")
    r = await ws.execute("sed -n '1,3p' /m/config.json")
    print(await r.stdout_str())

    print("=== cat /m/config.json | sed 's/\"//g' | head -n 3"
          " (strip quotes) ===")
    r = await ws.execute("cat /m/config.json | sed 's/\"//g' | head -n 3")
    print(await r.stdout_str())

    # ── find variants ───────────────────────────────────
    print("\n=== find /m/ -name '*.json' ===")
    r = await ws.execute("find /m/ -name '*.json'")
    print(await r.stdout_str())

    print("=== find /m/ -name '*.safetensors' ===")
    r = await ws.execute("find /m/ -name '*.safetensors'")
    print(await r.stdout_str())

    print("=== find /m/ -type f -size +1M ===")
    r = await ws.execute("find /m/ -type f -size +1M")
    print(await r.stdout_str())

    # ── pipelines ───────────────────────────────────────
    print("=== find /m/ -name '*.json' | sort | head ===")
    r = await ws.execute("find /m/ -name '*.json' | sort | head")
    print(await r.stdout_str())

    print("=== cat /m/config.json | grep -c ':' ===")
    r = await ws.execute("cat /m/config.json | grep -c ':'")
    print(f"  config keys: {(await r.stdout_str()).strip()}")

    # ── barriers ────────────────────────────────────────
    print("\n=== test for safetensors via grep -q ===")
    r = await ws.execute("ls /m/ | grep -q safetensors"
                         " && echo 'has weights' || echo 'no weights'")
    print(f"  {(await r.stdout_str()).strip()}")

    # ── quoting + command substitution ──────────────────
    print("\n=== quoting + $(...) ===")
    await ws.execute("export CFG=/m/config.json")
    r = await ws.execute('jq .hidden_size "$CFG"')
    print(f'  jq .hidden_size "$CFG": {(await r.stdout_str()).strip()}')

    r = await ws.execute("cat $(echo /m/config.json) | jq .num_hidden_layers")
    print(f"  via $(): {(await r.stdout_str()).strip()}")

    # ── background jobs ─────────────────────────────────
    print("\n=== background: jq fields in parallel ===")
    r = await ws.execute("jq .hidden_size /m/config.json &"
                         " jq .num_hidden_layers /m/config.json &"
                         " jq .vocab_size /m/config.json &"
                         " wait; echo done")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    # ── PROVISION ───────────────────────────────────────
    print("\n=== PROVISION (plan without executing) ===")
    await ws.cache.clear()
    before = ops_summary()

    dr = await ws.execute("cat /m/config.json", provision=True)
    show_plan("cat /m/config.json (tiny)", dr)

    dr = await ws.execute("cat /m/model.safetensors", provision=True)
    show_plan("cat /m/model.safetensors (2GB! plan only, no read)", dr)

    dr = await ws.execute("head -c 256 /m/model.safetensors", provision=True)
    show_plan("head -c 256 /m/model.safetensors (byte range, 256B)", dr)

    dr = await ws.execute("stat /m/model.safetensors", provision=True)
    show_plan("stat /m/model.safetensors (metadata, 0 bytes)", dr)

    dr = await ws.execute("jq .hidden_size /m/config.json", provision=True)
    show_plan("jq .hidden_size /m/config.json", dr)

    print(f"\n  before plans: {before}")
    print(f"  after plans:  {ops_summary()}  (planning is read-free)")

    # ── byte-range read of the safetensors header ───────
    print("\n=== STREAMING (range reads on 2GB weights) ===")

    async def measure(label: str, cmd: str) -> None:
        before_bytes = sum(rec.bytes for rec in ws.ops.records)
        t0 = time.monotonic()
        r = await ws.execute(cmd)
        dt = time.monotonic() - t0
        net = sum(rec.bytes for rec in ws.ops.records) - before_bytes
        out = (await r.stdout_str()).rstrip().splitlines()
        first = (out[0][:40] + "..." if out else "")
        print(f"  {label:42s} bytes={net:>9,}  t={dt:4.2f}s  "
              f"lines={len(out):>3}  out0={first!r}")

    await ws.cache.clear()
    await measure("head -c 128 model.safetensors (range)",
                  "head -c 128 /m/model.safetensors | xxd | head -n 4")
    await ws.cache.clear()
    await measure("stat -c '%s' model.safetensors",
                  "stat -c '%s' /m/model.safetensors")
    await ws.cache.clear()
    await measure("cat config.json | jq .vocab_size",
                  "cat /m/config.json | jq .vocab_size")
    await ws.cache.clear()
    await measure("wc -c config.json", "wc -c /m/config.json")

    print(f"\nFinal: {ops_summary()}")
    print("(2GB safetensors never fully downloaded; only header range "
          "+ configs read)")


if __name__ == "__main__":
    asyncio.run(main())
