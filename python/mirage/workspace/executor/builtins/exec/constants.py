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

# What `exec >&-` leaves a stream pointing at: a closed descriptor,
# whose writes are dropped. bash makes them fail with `Bad file
# descriptor`; mirage has no descriptor to fail, so it drops instead,
# a documented divergence.
CLOSED = ""

# What a dup names when it copies one of the terminal's own streams
# (`exec 2>&1`, `exec 1>&2`, `exec 1>&0`): the target, not the role, so
# a later rebinding of the copied descriptor does not move the copy.
# Distinct from every path (a virtual path starts with `/`) and from
# CLOSED.
TO_STDIN = "&0"
TO_STDOUT = "&1"
TO_STDERR = "&2"

# What `exec 1<f` binds a stream to: the file's read end, `<` then the
# virtual path. Distinct from a path (which starts with `/`), from CLOSED
# and from the terminal streams. A dup copies it (`exec 0<&1` reads the
# file), a transient `<&1` reads it, and a write to it fails as one to
# stdin's end does.
OPEN_FOR_READING = "<"

# The session fields an `exec` redirect line binds, put back as one
# unit when a later redirect on the line fails.
EXEC_STREAM_FIELDS = ("exec_stdout", "exec_stdout_append", "exec_stderr",
                      "exec_stderr_append", "exec_stdin",
                      "exec_stdin_unreadable", "exec_stdin_identity")
