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

from mirage.commands.builtin.hf_buckets import COMMANDS

EXPECTED = {
    "cat",
    "ls",
    "head",
    "tail",
    "grep",
    "rg",
    "wc",
    "find",
    "tree",
    "jq",
    "stat",
    "awk",
    "base64",
    "basename",
    "cmp",
    "column",
    "comm",
    "csplit",
    "cut",
    "diff",
    "dirname",
    "du",
    "expand",
    "file",
    "fmt",
    "fold",
    "gunzip",
    "gzip",
    "iconv",
    "join",
    "look",
    "md5",
    "mktemp",
    "nl",
    "paste",
    "readlink",
    "realpath",
    "rev",
    "sed",
    "sha256sum",
    "shuf",
    "sort",
    "split",
    "strings",
    "tac",
    "tar",
    "tr",
    "tsort",
    "unexpand",
    "uniq",
    "unzip",
    "xxd",
    "zcat",
    "zgrep",
    "zip",
}


def test_commands_exported():
    names = sorted(c._registered_commands[0].name for c in COMMANDS)
    assert set(names) >= EXPECTED
