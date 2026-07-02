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

import sys
from pathlib import Path

_INTEG_DIR = str(Path(__file__).parent)
sys.path[:] = [p for p in sys.path if p not in (_INTEG_DIR, "")]

import asyncio  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402

import lancedb  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.resource.lancedb import LanceDBConfig  # noqa: E402
from mirage.resource.lancedb import LanceDBResource  # noqa: E402

MOUNT = "/db/"

ROWS = [
    {
        "id": 1,
        "label": "cat",
        "kind": "big",
        "name": "a big orange cat"
    },
    {
        "id": 2,
        "label": "cat",
        "kind": "small",
        "name": "a small grey cat"
    },
    {
        "id": 3,
        "label": "dog",
        "kind": "big",
        "name": "a big brown dog"
    },
    {
        "id": 4,
        "label": "dog",
        "kind": "small",
        "name": "a small white dog"
    },
]

CASES: list[tuple[str, str]] = [
    ("ls_root", "ls {root}"),
    ("ls_table", "ls {root}animals"),
    ("ls_group", "ls {root}animals/cat"),
    ("tree_table", "tree {root}animals"),
    ("find_md", "find {root}animals -name '*.md'"),
    ("cat_card", "cat {root}animals/cat/big/1.md"),
    ("wc_c_card", "wc -c {root}animals/cat/big/1.md"),
    # cold (bespoke) then warm (cache-mount generic) must be identical
    ("grep_cold_single", "grep orange {root}animals/cat/big/1.md"),
    ("grep_warm_single", "grep orange {root}animals/cat/big/1.md"),
    ("grep_i", "grep -i ORANGE {root}animals/cat/big/1.md"),
    ("grep_n", "grep -n label {root}animals/cat/big/1.md"),
    ("grep_v", "grep -v cat {root}animals/cat/big/1.md"),
    ("grep_c", "grep -c cat {root}animals/cat/big/1.md"),
    ("grep_o", "grep -o cat {root}animals/cat/big/1.md"),
    ("grep_w", "grep -w cat {root}animals/cat/big/1.md"),
    ("grep_F_literal", 'grep -F "id: 1" {root}animals/cat/big/1.md'),
    ("grep_m1", "grep -m 1 cat {root}animals/cat/big/1.md"),
    ("grep_A1", "grep -A 1 id {root}animals/cat/big/1.md"),
    ("grep_B1", "grep -B 1 label {root}animals/cat/big/1.md"),
    ("grep_C1", "grep -C 1 label {root}animals/cat/big/1.md"),
    ("grep_multi",
     "grep small {root}animals/cat/small/2.md {root}animals/dog/small/4.md"),
    ("grep_r_table", "grep -r orange {root}animals"),
    ("grep_r_multipath", "grep -r small {root}animals/cat {root}animals/dog"),
    ("grep_rl", "grep -rl cat {root}animals"),
    ("grep_E_alt", 'grep -E "orange|brown" {root}animals/cat/big/1.md'),
    ("pipe_grep_stdin", "cat {root}animals/cat/big/1.md | grep orange"),
    ("rg_basic", "rg orange {root}animals/cat/big/1.md"),
    # du has no native op on lancedb -> exercises the stat/readdir walk
    # fallback, which must match the Python du builder byte for byte.
    ("du_file", "du {root}animals/cat/big/1.md"),
    ("du_group", "du {root}animals/cat"),
    ("du_table", "du {root}animals"),
    ("du_c_multi", "du -c {root}animals/cat {root}animals/dog"),
]

EXIT_CODE_CASES: list[tuple[str, str]] = [
    ("grep_q_match", "grep -q cat {root}animals/cat/big/1.md"),
    ("grep_q_no_match", "grep -q zebra {root}animals/cat/big/1.md"),
    ("grep_no_match", "grep zebra {root}animals/cat/big/1.md"),
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
    nf_target = f"{MOUNT.rstrip('/')}/__nf_missing__.txt"
    for nf_name, nf_prog in (("nf_cat", "cat"), ("nf_head", "head"),
                             ("nf_tail", "tail"), ("nf_wc", "wc"),
                             ("nf_stat", "stat"), ("nf_grep", "grep x")):
        result = await ws.execute(f"{nf_prog} {nf_target}")
        err = (await result.stderr_str()).strip()
        print(f"=== {nf_name} ===")
        print(f"exit={result.exit_code}")
        if err:
            print(err)
    prov_target = f"{MOUNT}animals/cat/big/1.md"
    for pv_name, pv_cmd in (("prov_probe_cat", f"cat {prov_target}"),
                            ("prov_probe_grep", f"grep x {prov_target}"),
                            ("prov_probe_ls", f"ls {MOUNT}animals/cat/big")):
        result = await ws.execute(pv_cmd, provision=True)
        print(f"=== {pv_name} ===")
        print(f"net={result.network_read} write={result.network_write} "
              f"cache={result.cache_read} ops={result.read_ops} "
              f"hits={result.cache_hits} "
              f"precision={result.precision.value}")


async def main() -> None:
    uri = tempfile.mkdtemp(prefix="mirage-integ-lancedb-")
    try:
        db = lancedb.connect(uri)
        db.create_table("animals", data=ROWS)
        config = LanceDBConfig(
            uri=uri,
            group_by=["label", "kind"],
            id_column="id",
            title_column="name",
            text_column="name",
        )
        ws = Workspace({MOUNT: LanceDBResource(config)}, mode=MountMode.READ)
        # Vector search (the `search` command) is not exercised here: the
        # seed table ships no vector column. It is covered by unit tests
        # (tests/core/lancedb/test_search.py).
        await run_cases(ws)
    finally:
        shutil.rmtree(uri, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
