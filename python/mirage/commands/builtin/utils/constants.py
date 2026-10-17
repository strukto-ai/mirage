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

from mirage.types import FileType, PathSpec

MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)

EPOCH_LS_TIME = "Jan  1 00:00"

# GNU's simple-backup suffix (mv/cp -b), overridable with -S.
DEFAULT_BACKUP_SUFFIX = "~"

# A terminal `cat` of an endless character device must be bounded before
# workspace materialization. Regular files keep the ordinary line-only cap.
CHAR_DEVICE_MAX_BYTES = 8 << 20

# GNU's name for stdin: head and tail's ``==> name <==`` header, and the
# checksum list a ``*sum -c`` diagnostic names.
STDIN_HEADER_NAME = "standard input"

# grep's name for stdin in a match prefix or diagnostic, unless --label
# names another.
GREP_STDIN_LABEL = "(standard input)"

# How long curl and wget wait on a request when the line sets no limit
# of its own.
HTTP_TIMEOUT_SECONDS = 30

# The operand a command reads stdin through when the line names none.
STDIN_OPERAND = PathSpec(virtual="-", directory="-", vfs_path="-")

TYPE_CHARS = {
    FileType.DIRECTORY: "d",
    FileType.SYMLINK: "l",
    FileType.CHAR_DEVICE: "c",
    FileType.BLOCK_DEVICE: "b",
    FileType.FIFO: "p",
    FileType.SOCKET: "s",
}

# GNU ls's window of "recent" times: half a Gregorian year of 365.2425
# days, in seconds (ls.c). findutils draws its own line (listfile.c):
# old past 180 days, future past an hour.
LS_RECENT_SECONDS = 31556952 // 2
FIND_OLD_SECONDS = 180 * 24 * 60 * 60
FIND_FUTURE_SECONDS = 60 * 60

# How `find -ls` spells a name: findutils escapes these so the row
# stays one line and re-parseable.
FIND_LS_ESCAPES = {
    "\\": "\\\\",
    " ": "\\ ",
    '"': '\\"',
    "\n": "\\n",
    "\t": "\\t",
    "\r": "\\r",
    "\a": "\\a",
    "\b": "\\b",
    "\f": "\\f",
    "\v": "\\v",
}
