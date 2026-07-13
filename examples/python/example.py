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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource

load_dotenv(".env.development")

config = S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
)

s3 = S3Resource(config)
mem = RAMResource()
# The stdin-piping demos below need `sys.stdin`, which only the local
# runtime provides; the default monty sandbox has no stdin.
ws = Workspace(
    {
        "/s3/": s3,
        "/work/": (mem, MountMode.WRITE),
    },
    mode=MountMode.EXEC,
    python_runtime="local",
)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


STDIN_SCRIPT = """\
import sys, json
for line in sys.stdin:
    rec = json.loads(line)
    print(rec.get("type", "unknown"))
"""


async def main():
    print("=== pipe S3 data into python3 -c via stdin ===\n")

    print("--- cat example.jsonl | python3 -c (single line) ---")
    result = await ws.execute(
        'cat /s3/data/example.jsonl | python3 -c "import sys; '
        "print(f'lines: {sum(1 for _ in sys.stdin)}')\"")
    print(await result.stdout_str())
    print(f"Exit code: {result.exit_code}")
    print(f"Stats: {ops_summary()}\n")

    print("--- head -n 3 example.jsonl | python3 -c (multiline) ---")
    result = await ws.execute('head -n 3 /s3/data/example.jsonl | '
                              'python3 -c "import sys, json\n'
                              'for line in sys.stdin:\n'
                              '    rec = json.loads(line)\n'
                              "    print(rec.get('type', 'unknown'))\n"
                              '"')
    print(await result.stdout_str())
    print(f"Exit code: {result.exit_code}")
    print(f"Stats: {ops_summary()}\n")

    print("=== pipe S3 data into python3 -c (extract + head) ===\n")

    result = await ws.execute('cat /s3/data/example.jsonl | '
                              'python3 -c "import sys, json\n'
                              'for line in sys.stdin:\n'
                              '    rec = json.loads(line)\n'
                              '    print(json.dumps(rec)[:80])\n'
                              '" | head -n 3')
    print(await result.stdout_str())
    print(f"Exit code: {result.exit_code}")
    print(f"Stats: {ops_summary()}\n")

    print("=== python3 script file via VFS ===\n")

    await ws.execute("mkdir /work/scripts")
    await ws.execute(f"echo '{STDIN_SCRIPT}' > /work/scripts/parse_stdin.py")

    print("--- head -n 5 example.jsonl | python3 parse_stdin.py ---")
    result = await ws.execute("head -n 5 /s3/data/example.jsonl"
                              " | python3 /work/scripts/parse_stdin.py")
    print(await result.stdout_str())
    if result.stderr:
        print("STDERR:", await result.stderr_str())
    print(f"Exit code: {result.exit_code}")
    print(f"Stats: {ops_summary()}\n")

    print("=== python3 -c: count + aggregate ===\n")

    result = await ws.execute('cat /s3/data/example.jsonl | '
                              'python3 -c "import sys, json\n'
                              'from collections import Counter\n'
                              'counts = Counter()\n'
                              'for line in sys.stdin:\n'
                              '    rec = json.loads(line)\n'
                              "    counts[rec.get('type', 'unknown')] += 1\n"
                              'for k, v in counts.most_common(5):\n'
                              "    print(f'{k}: {v}')\n"
                              '"')
    print(await result.stdout_str())
    print(f"Exit code: {result.exit_code}")
    print(f"Stats: {ops_summary()}\n")

    print("=== python3 -c with session env ===\n")

    await ws.execute("export GREETING=hello_from_mirage")
    result = await ws.execute(
        'python3 -c "import os; print(os.environ.get(\'GREETING\', \'none\'))"'
    )
    print(await result.stdout_str())
    print(f"Exit code: {result.exit_code}")
    print(f"Stats: {ops_summary()}")

    # ── heredoc patterns commonly used by AI agents ──
    # These exercise the heredoc fixes: dash-strip + quoted delimiter.

    print("\n=== python3 << 'PYEOF' (quoted: $X stays literal) ===")
    await ws.execute("export X=shellval")
    result = await ws.execute("python3 << 'PYEOF'\n"
                              "x = '$X'  # literal, no shell expansion\n"
                              "print(x)\n"
                              "PYEOF")
    print(f"  stdout: {(await result.stdout_str()).strip()} "
          f"(expect '$X')")

    print("\n=== python3 << PYEOF (unquoted: $X expanded) ===")
    result = await ws.execute("python3 << PYEOF\n"
                              "print('$X')\n"
                              "PYEOF")
    print(f"  stdout: {(await result.stdout_str()).strip()} "
          f"(expect 'shellval')")

    print("\n=== python3 <<-PYEOF (dash: tabs stripped, indented body) ===")
    result = await ws.execute("python3 <<-PYEOF\n"
                              "\tfor i in range(3):\n"
                              "\t    print(f'item-{i}')\n"
                              "\tPYEOF")
    out = (await result.stdout_str()).strip()
    print(f"  stdout: {out!r} (expect 3 items)")

    print("\n=== python3 << EOF | grep keep (heredoc + pipe) ===")
    result = await ws.execute("python3 << EOF | grep keep\n"
                              "for i in range(5):\n"
                              "    print('keep' if i % 2 else 'drop', i)\n"
                              "EOF")
    out = (await result.stdout_str()).strip()
    print(f"  filtered: {out.splitlines()}")

    print("\n=== heredoc in for-loop (body re-fires per iter) ===")
    result = await ws.execute(
        "for name in alice bob carol; do python3 <<-PYEOF\n"
        "\tname = '$name'\n"
        "\tprint(f'hello, {name}!')\n"
        "\tPYEOF\n"
        "done")
    for line in (await result.stdout_str()).strip().splitlines():
        print(f"  {line}")

    await ws.close()


asyncio.run(main())
