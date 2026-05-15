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

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource


async def main() -> None:
    ws = Workspace({"/ram": RAMResource()}, mode=MountMode.EXEC)

    print("=== python3 -c (basic) ===")
    r = await ws.execute('python3 -c "print(42)"')
    print(f"stdout: {(await r.stdout_str()).strip()}  (expected: 42)")

    print("\n=== python3 -c with argv (flag-conditional) ===")
    r = await ws.execute(
        'python3 -c "import sys; print(sys.argv[1:])" alpha beta')
    print(f"argv after -c: {(await r.stdout_str()).strip()}  "
          f"(expected: ['alpha', 'beta'])")

    print("\n=== python3 /ram/script.py (abs path → dispatch read) ===")
    await ws.execute("echo 'print(\"hello from vfs\")' > /ram/h.py")
    r = await ws.execute("python3 /ram/h.py")
    print(f"stdout: {(await r.stdout_str()).strip()}  "
          f"(expected: hello from vfs)")

    print("\n=== python3 /abs/script.py arg1 arg2 (script + argv) ===")
    await ws.execute("echo 'import sys; print(sys.argv[1:])' > /ram/argv.py")
    r = await ws.execute("python3 /ram/argv.py one two")
    print(f"argv after script: {(await r.stdout_str()).strip()}  "
          f"(expected: ['one', 'two'])")

    print("\n=== python3 bare-name script via cwd ===")
    r = await ws.execute("cd /ram && python3 h.py")
    print(f"stdout: {(await r.stdout_str()).strip()}  "
          f"(expected: hello from vfs)")

    print("\n=== echo code | python3 (stdin) ===")
    r = await ws.execute('echo "print(7*6)" | python3')
    print(f"stdout: {(await r.stdout_str()).strip()}  (expected: 42)")

    print("\n=== heredoc ===")
    r = await ws.execute("python3 <<PYEOF\nprint(1 + 2)\nPYEOF")
    print(f"stdout: {(await r.stdout_str()).strip()}  (expected: 3)")

    print("\n=== session env passthrough ===")
    await ws.execute("export GREETING=hello_mirage")
    r = await ws.execute(
        "python3 -c \"import os; print(os.environ.get('GREETING','none'))\"")
    print(
        f"stdout: {(await r.stdout_str()).strip()}  (expected: hello_mirage)")

    await ws.close()


asyncio.run(main())
