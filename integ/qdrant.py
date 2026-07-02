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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from qdrant_client import AsyncQdrantClient, models  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.resource.qdrant import QdrantConfig, QdrantResource  # noqa: E402

QDRANT_URL = os.environ.get("QDRANT_URL")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY")
QDRANT_HOST = os.environ.get("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.environ.get("QDRANT_PORT", "6333"))
EMBED_DIM = 8
COLLECTION = "mirage_integ"
MOUNT = "/db/"

ROWS = [
    (1, "cat", "big", "a big orange cat"),
    (2, "cat", "small", "a small grey cat"),
    (3, "dog", "big", "a big brown dog"),
    (4, "dog", "small", "a small white dog"),
]

CASES: list[tuple[str, str]] = [
    ("ls_root", "ls {root}"),
    ("ls_group", "ls {root}cat"),
    ("ls_leaf", "ls {root}cat/big"),
    ("tree", "tree {root}"),
    ("find_txt", "find {root} -name '*.txt'"),
    ("find_json", "find {root} -name '*.json'"),
    ("cat_txt", "cat {root}cat/big/1.txt"),
    ("cat_json", "cat {root}cat/big/1.json"),
    ("wc_c_txt", "wc -c {root}cat/big/1.txt"),
    ("grep_text", "grep orange {root}cat/big/1.txt"),
    ("grep_json_field", "grep label {root}cat/big/1.json"),
    ("grep_i", "grep -i ORANGE {root}cat/big/1.txt"),
    ("grep_n", "grep -n cat {root}cat/big/1.json"),
    ("grep_c", "grep -c cat {root}cat/big/1.json"),
    ("grep_o", "grep -o cat {root}cat/big/1.json"),
    ("grep_w", "grep -w big {root}cat/big/1.json"),
    ("grep_F_literal", "grep -F 'orange cat' {root}cat/big/1.txt"),
    ("grep_E_alt", 'grep -E "orange|brown" {root}cat/big/1.txt'),
    ("grep_v", "grep -v zebra {root}cat/big/1.txt"),
    ("grep_multi", "grep small {root}cat/small/2.json {root}dog/small/4.json"),
    ("grep_r_group", "grep -r orange {root}cat"),
    ("grep_rl", "grep -rl cat {root}"),
    ("pipe_grep_stdin", "cat {root}cat/big/1.json | grep orange"),
    ("rg_basic", "rg orange {root}cat/big/1.txt"),
    # du has no native op -> exercises the stat/readdir walk fallback,
    # which must match the Python du builder byte for byte.
    ("du_leaf", "du {root}cat/big"),
    ("du_group", "du {root}cat"),
    ("du_root", "du {root}"),
    ("du_c_multi", "du -c {root}cat {root}dog"),
    # symlink into the mount (namespace state; works on a read-only backend)
    ("sym_ln", "ln -s {root}cat/big/1.json {root}meta_link"),
    ("sym_readlink", "readlink {root}meta_link"),
    ("sym_cat", "cat {root}meta_link"),
    ("sym_grep", "grep label {root}meta_link"),
    ("sym_ls", "ls -F {root} | grep meta_link"),
    ("sym_rm", "rm {root}meta_link && ls {root}"),
]

EXIT_CODE_CASES: list[tuple[str, str]] = [
    ("grep_q_match", "grep -q cat {root}cat/big/1.txt"),
    ("grep_q_no_match", "grep -q zebra {root}cat/big/1.txt"),
    ("grep_no_match", "grep zebra {root}cat/big/1.txt"),
]


async def run_cases(ws: Workspace) -> None:
    for name, tmpl in CASES:
        result = await ws.execute(tmpl.format(root=MOUNT))
        out = await result.stdout_str()
        print(f"=== {name} ===")
        print(out, end="" if out.endswith("\n") else "\n")
    for name, tmpl in EXIT_CODE_CASES:
        result = await ws.execute(tmpl.format(root=MOUNT))
        out = await result.stdout_str()
        print(f"=== {name} ===")
        print(f"exit={result.exit_code}")
        if out:
            print(out, end="" if out.endswith("\n") else "\n")
    nf_target = f"{MOUNT.rstrip('/')}/cat/big/__nf_missing__.json"
    for nf_name, nf_prog in (("nf_cat", "cat"), ("nf_head", "head"),
                             ("nf_tail", "tail"), ("nf_wc", "wc"),
                             ("nf_stat", "stat"), ("nf_grep", "grep x")):
        result = await ws.execute(f"{nf_prog} {nf_target}")
        err = (await result.stderr_str()).strip()
        print(f"=== {nf_name} ===")
        print(f"exit={result.exit_code}")
        if err:
            print(err)
    prov_target = f"{MOUNT}cat/big/1.txt"
    for pv_name, pv_cmd in (("prov_probe_cat", f"cat {prov_target}"),
                            ("prov_probe_grep", f"grep x {prov_target}"),
                            ("prov_probe_ls", f"ls {MOUNT}cat/big")):
        result = await ws.execute(pv_cmd, provision=True)
        print(f"=== {pv_name} ===")
        print(f"net={result.network_read} write={result.network_write} "
              f"cache={result.cache_read} ops={result.read_ops} "
              f"hits={result.cache_hits} "
              f"precision={result.precision.value}")


def _client() -> AsyncQdrantClient:
    if QDRANT_URL:
        return AsyncQdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)
    return AsyncQdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)


async def seed(client: AsyncQdrantClient) -> None:
    await client.delete_collection(COLLECTION)
    await client.create_collection(COLLECTION,
                                   vectors_config=models.VectorParams(
                                       size=EMBED_DIM,
                                       distance=models.Distance.COSINE))
    await client.upsert(COLLECTION,
                        points=[
                            models.PointStruct(id=i,
                                               vector=[0.1] * EMBED_DIM,
                                               payload={
                                                   "label": label,
                                                   "kind": kind,
                                                   "name": name
                                               })
                            for i, label, kind, name in ROWS
                        ])
    for field in ("label", "kind"):
        await client.create_payload_index(
            COLLECTION,
            field_name=field,
            field_schema=models.PayloadSchemaType.KEYWORD)
    await asyncio.sleep(2)


async def main() -> None:
    client = _client()
    try:
        await seed(client)
        config = QdrantConfig(
            url=QDRANT_URL,
            api_key=QDRANT_API_KEY,
            host=QDRANT_HOST,
            port=QDRANT_PORT,
            collection=COLLECTION,
            group_by=["label", "kind"],
            id_field="id",
            text_field="name",
        )
        ws = Workspace({MOUNT: QdrantResource(config)}, mode=MountMode.READ)
        await run_cases(ws)
    finally:
        await client.delete_collection(COLLECTION)


if __name__ == "__main__":
    asyncio.run(main())
