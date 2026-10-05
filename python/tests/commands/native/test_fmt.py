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

import shutil
import subprocess

import pytest


def _native_fmt_is_gnu() -> bool:
    if shutil.which("fmt") is None:
        return False
    version = subprocess.run(
        ["fmt", "--version"], capture_output=True, text=True, check=False
    )
    return "GNU" in version.stdout


gnu_fmt = pytest.mark.skipif(
    not _native_fmt_is_gnu(),
    reason="mirage follows GNU fmt; macOS ships BSD fmt's greedy fill",
)


@gnu_fmt
def test_fmt_w(env):
    data = b"this is a long line that should be wrapped\n"
    assert env.mirage("fmt -w 20", stdin=data) == env.native(
        "fmt -w 20", stdin=data
    )


@gnu_fmt
def test_fmt_file(env):
    env.create_file("f.txt", b"short words in a line\n")
    assert env.mirage("fmt -w 15 /data/f.txt") == env.native("fmt -w 15 f.txt")
