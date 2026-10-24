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

from mirage.workspace.documentation.types import Change

# The paragraph that opens VFS.md for an agent.
INTRO = (
    "You work in a terminal over a virtual filesystem. Read files with "
    "shell commands; access is checked for each operation."
)

# The file commands VFS.md names as reading every path.
READS = ("ls", "cat", "grep", "find", "jq")

# The commands that change files: each works on a mount that answers
# every op of one alternative. A mount answers append and truncate by a
# rewrite where it only writes whole files, and cp copies within a mount
# through its copy, and a whole tree to a new place through its dir_copy.
CHANGES = (
    Change("`>`", (), (("write",),)),
    Change("`>>`", (), (("append",),)),
    Change("`tee`", ("tee",), (("write",),)),
    Change("`touch` of a new file", ("touch",), (("write",),)),
    Change("`cp`", ("cp",), (("write",), ("copy",))),
    Change(
        "`cp -r`",
        ("cp", "-r"),
        (("write", "mkdir"), ("copy", "mkdir"), ("copy", "dir_copy")),
    ),
    Change("`mkdir`", ("mkdir",), (("mkdir",),)),
    Change("`mv`", ("mv",), (("rename",),)),
    Change("`rm`", ("rm",), (("unlink",),)),
    Change("`unlink`", ("unlink",), (("unlink",),)),
    Change("`rm -r`", ("rm", "-r"), (("rm_r",), ("unlink", "rmdir"))),
    Change("`rmdir`", ("rmdir",), (("rmdir",),)),
    Change("`truncate`", ("truncate",), (("truncate",),)),
    Change("`sed -i`", ("sed", "-i"), (("write",),)),
)

# The ops a mount's service answers in place of reading a file, and the
# command each one serves.
ASKS = (
    ("first_lines", "head"),
    ("last_lines", "tail"),
    ("line_count", "wc -l"),
)

# The walks a mount's walk_limit stops, and the commands it refuses
# past it.
WALKS = ("grep -r", "find", "du")
REFUSED = ("tar -c", "cp -r", "rm -r")
