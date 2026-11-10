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

# Each unit option of ``free``: its power of its base, and whether that
# base is 1000.
FREE_UNITS: dict[str, tuple[int, bool]] = {
    "b": (0, False),
    "kilo": (1, True),
    "mega": (2, True),
    "giga": (3, True),
    "tera": (4, True),
    "peta": (5, True),
    "k": (1, False),
    "m": (2, False),
    "g": (3, False),
    "tebi": (4, False),
    "pebi": (5, False),
}

# ``free``'s width for its row labels, its first column and the others.
FREE_LABEL_WIDTH = 7
FREE_FIRST_WIDTH = 13
FREE_WIDTH = 12

# ``free -h``'s unit letters, and the most characters a figure may take.
HUMAN_UNITS = "KMGTPE"
HUMAN_DIGITS = 3

# What ``free`` prints for a figure the machine has no such thing for.
NO_FIGURE = "-"

# Where ``lscpu`` starts its values, and the rows too wide to sit beside
# another machine's, which ``lscpu --machine`` still prints.
LSCPU_VALUE_COLUMN = 41
LSCPU_WIDE_ROWS = ("Flags:", "Vulnerability ")

# The rests between ``free -c`` passes without ``-s``, and top's.
FREE_DELAY_SECONDS = 1.0
TOP_DELAY_SECONDS = 3.0

# ``top``'s line width when nothing says how wide.
TOP_WIDTH = 80

# ``top -E``: each scale's memory unit, in bytes.
TOP_SCALES: dict[str, tuple[str, int]] = {
    "k": ("KiB", 1024),
    "m": ("MiB", 1024**2),
    "g": ("GiB", 1024**3),
    "t": ("TiB", 1024**4),
    "p": ("PiB", 1024**5),
    "e": ("EiB", 1024**6),
}

# ``top -o``: each field it sorts by, and whether the largest goes first.
TOP_SORT_FIELDS: dict[str, bool] = {
    "PID": False,
    "USER": False,
    "VIRT": True,
    "RES": True,
    "%CPU": True,
    "%MEM": True,
    "TIME+": True,
    "COMMAND": False,
}

# ``uptime -p``'s parts, largest first: each name and its seconds.
PRETTY_UNITS: tuple[tuple[str, int], ...] = (
    ("decade", 3650 * 86400),
    ("year", 365 * 86400),
    ("week", 7 * 86400),
    ("day", 86400),
    ("hour", 3600),
)
