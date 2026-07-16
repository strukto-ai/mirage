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
import importlib.util
import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path

INTEG = Path(__file__).resolve().parents[2]

TARGETS = ["ram", "disk", "redis", "opfs", "s3", "s3-prefix"]

GROUPS = [
    "CASES",
    "EXIT_CODE_CASES",
    "NOT_FOUND_CASES",
    "PARTIAL_READ_CASES",
    "FIND_ARG_ERROR_CASES",
    "CROSS_MOUNT_CASES",
    "CROSS_MOUNT_EXIT_CASES",
    "CROSS_MOUNT_ERR_CASES",
]

BASH_PREFIXES = {
    "cwd",
    "pipe",
    "glob",
    "redirect",
    "arith",
    "subshell",
    "var",
    "source",
    "shift",
    "read",
    "return",
    "case",
    "history",
    "quoted",
    "relative",
    "relword",
    "relspell",
    "midglob",
    "bash",
    "heredoc",
    "brace",
    "param",
    "test",
}


def load_cases_module():
    spec = importlib.util.spec_from_file_location("legacy_cases",
                                                  INTEG / "cases.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["legacy_cases"] = module
    spec.loader.exec_module(module)
    return module


def classify(case_id: str) -> str:
    prefix = case_id.split("_")[0]
    if prefix == "xm":
        parts = case_id.split("_")
        sub = parts[1] if len(parts) > 1 else "misc"
        return f"crossmount/{sub}.json"
    if prefix in BASH_PREFIXES:
        return f"bash/{prefix}.json"
    return f"unix/{prefix}.json"


def write_fixture(seed_files: dict) -> None:
    base = INTEG / "fixtures" / "files" / "v1"
    shutil.rmtree(base, ignore_errors=True)
    for path, content in seed_files.items():
        rel = path[len("/data/"):] if path.startswith("/data/") else path
        dest = base / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = content.encode() if isinstance(content, str) else content
        dest.write_bytes(data)


async def seed(ws, seed_files: dict) -> None:
    for path, content in seed_files.items():
        await ws.execute(f"mkdir -p {path.rsplit('/', 1)[0]}")
        data = content.encode() if isinstance(content, str) else content
        await ws.execute(f"tee {path} > /dev/null", stdin=data)


async def main() -> None:
    module = load_cases_module()
    seed_files = module.SEED_FILES

    from mirage import MountMode, Workspace
    from mirage.resource.ram import RAMResource

    write_fixture(seed_files)

    ws = Workspace({
        "/data": RAMResource(),
        "/data2": RAMResource()
    },
                   mode=MountMode.WRITE)
    await seed(ws, seed_files)

    buckets: dict[str, list[dict]] = defaultdict(list)
    seq = 0
    for group in GROUPS:
        cases = getattr(module, group)
        for row in cases:
            case_id, command = row[0], row[1]
            result = await ws.execute(command)
            out = await result.stdout_str()
            err = await result.stderr_str()
            case = {
                "id": case_id,
                "seq": seq,
                "targets": TARGETS,
                "command": command,
                "expect": {
                    "exit": result.exit_code,
                    "stdout": out,
                    "stderr": err,
                },
            }
            buckets[classify(case_id)].append(case)
            seq += 1

    for name in ("unix", "bash", "crossmount"):
        shutil.rmtree(INTEG / name, ignore_errors=True)
    for rel, cases in sorted(buckets.items()):
        dest = INTEG / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(
            json.dumps({"cases": cases}, indent=2, ensure_ascii=False) + "\n")

    print(f"wrote {len(buckets)} files, {seq} cases")
    for rel, cases in sorted(buckets.items()):
        print(f"  {rel:34} {len(cases)}")


if __name__ == "__main__":
    asyncio.run(main())
