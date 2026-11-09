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


from mirage.execution.process.types import ProcessState

# procps-ng 4.0.4's usage block, printed under every option error.
USAGE = (
    "\nUsage:\n ps [options]\n\n"
    " Try 'ps --help <simple|list|output|threads|misc|all>'\n"
    "  or 'ps --help <s|l|o|t|m|a>'\n"
    " for additional help text.\n\n"
    "For more details see ps(1).\n"
)


# procps-ng 4.0.4's -o keys: the header, width and right alignment
# measured from its ``ps -o`` output, and the fact ``_ps_cell`` renders;
# accounting a runner lacks prints procps's none.
COLUMNS: dict[str, tuple[str, int, bool, str]] = {
    "pid": ("PID", 7, True, "pid"),
    "tgid": ("TGID", 7, True, "pid"),
    "lwp": ("LWP", 7, True, "pid"),
    "spid": ("SPID", 7, True, "pid"),
    "tid": ("TID", 7, True, "pid"),
    "ppid": ("PPID", 7, True, "ppid"),
    "pgid": ("PGID", 7, True, "pgid"),
    "pgrp": ("PGRP", 7, True, "pgid"),
    "sid": ("SID", 7, True, "sid"),
    "sess": ("SESS", 7, True, "sid"),
    "tpgid": ("TPGID", 7, True, "tpgid"),
    "stat": ("STAT", 4, False, "stat"),
    "state": ("S", 1, False, "state"),
    "s": ("S", 1, False, "state"),
    "cmd": ("CMD", 27, False, "args"),
    "args": ("COMMAND", 27, False, "args"),
    "command": ("COMMAND", 27, False, "args"),
    "comm": ("COMMAND", 15, False, "comm"),
    "ucmd": ("CMD", 15, False, "comm"),
    "ucomm": ("COMMAND", 15, False, "comm"),
    "user": ("USER", 8, False, "user"),
    "euser": ("EUSER", 8, False, "user"),
    "uname": ("USER", 8, False, "user"),
    "ruser": ("RUSER", 8, False, "user"),
    "suser": ("SUSER", 8, False, "user"),
    "fuser": ("FUSER", 8, False, "user"),
    "uid": ("UID", 5, True, "user"),
    "euid": ("EUID", 5, True, "user"),
    "ruid": ("RUID", 5, True, "user"),
    "suid": ("SUID", 5, True, "user"),
    "fuid": ("FUID", 5, True, "user"),
    "gid": ("GID", 5, True, "group"),
    "egid": ("EGID", 5, True, "group"),
    "rgid": ("RGID", 5, True, "group"),
    "group": ("GROUP", 8, False, "group"),
    "egroup": ("EGROUP", 8, False, "group"),
    "rgroup": ("RGROUP", 8, False, "group"),
    "tty": ("TT", 8, False, "tty"),
    "tt": ("TT", 8, False, "tty"),
    "tname": ("TTY", 8, False, "tty"),
    "time": ("TIME", 8, True, "time"),
    "cputime": ("TIME", 8, True, "time"),
    "cputimes": ("TIME", 8, True, "zero"),
    "etime": ("ELAPSED", 11, True, "etime"),
    "etimes": ("ELAPSED", 7, True, "etimes"),
    "lstart": ("STARTED", 24, True, "lstart"),
    "start": ("STARTED", 8, True, "start"),
    "start_time": ("START", 5, False, "stime"),
    "stime": ("STIME", 5, False, "stime"),
    "bsdstart": ("START", 6, True, "bsdstart"),
    "rss": ("RSS", 5, True, "zero"),
    "rssize": ("RSS", 5, True, "zero"),
    "rsz": ("RSZ", 5, True, "zero"),
    "vsz": ("VSZ", 6, True, "zero"),
    "vsize": ("VSZ", 6, True, "zero"),
    "sz": ("SZ", 5, True, "zero"),
    "trs": ("TRS", 4, True, "zero"),
    "drs": ("DRS", 5, True, "zero"),
    "dsiz": ("DSIZ", 4, True, "zero"),
    "size": ("SIZE", 5, True, "zero"),
    "pss": ("PSS", 5, True, "zero"),
    "uss": ("USS", 5, True, "zero"),
    "maj_flt": ("MAJFL", 6, True, "zero"),
    "min_flt": ("MINFL", 6, True, "zero"),
    "majflt": ("MAJFLT", 6, True, "zero"),
    "minflt": ("MINFLT", 6, True, "zero"),
    "%cpu": ("%CPU", 4, True, "percent"),
    "pcpu": ("%CPU", 4, True, "percent"),
    "%mem": ("%MEM", 4, True, "percent"),
    "pmem": ("%MEM", 4, True, "percent"),
    "c": ("C", 2, True, "zero"),
    "cp": ("CP", 3, True, "zero"),
    "ni": ("NI", 3, True, "zero"),
    "nice": ("NI", 3, True, "zero"),
    "pri": ("PRI", 3, True, "pri"),
    "priority": ("PRI", 3, True, "priority"),
    "opri": ("PRI", 3, True, "opri"),
    "rtprio": ("RTPRIO", 6, True, "dash"),
    "cls": ("CLS", 3, True, "cls"),
    "class": ("CLS", 3, False, "cls"),
    "policy": ("POL", 3, False, "cls"),
    "psr": ("PSR", 3, True, "zero"),
    "nlwp": ("NLWP", 4, True, "one"),
    "thcount": ("THCNT", 5, True, "one"),
    "f": ("F", 1, False, "zero"),
    "flag": ("F", 1, False, "zero"),
    "flags": ("F", 1, False, "zero"),
    "wchan": ("WCHAN", 6, False, "dash"),
    "nwchan": ("WCHAN", 6, True, "dash"),
    "label": ("LABEL", 31, False, "dash"),
    "machine": ("MACHINE", 31, False, "machine"),
}


# What ps prints without -o: each process's pid, the machine it runs on
# (``mirage`` for Mirage's own) and its command.
PLAIN = (
    ("pid", "PID"),
    ("machine", "MACHINE"),
    ("cmd", "CMD"),
)

# What a forest (BSD ``f``, ``--forest``) puts before each command, as
# procps-ng 4.0.4 draws it: a child's branch, then for each ancestor
# between it and the root a bar while that ancestor has a later sibling.
BRANCH = " \\_ "
BAR = " |  "
GAP = "    "


# The fixed answers for a runner: what procps prints for a process on no
# terminal, never scheduled away from the default policy and priority.
FIXED = {
    "tpgid": "-1",
    "tty": "?",
    "time": "00:00:00",
    "zero": "0",
    "one": "1",
    "percent": "0.0",
    "pri": "19",
    "priority": "20",
    "opri": "80",
    "dash": "-",
    "cls": "TS",
}


# A runner's state letter: live and waiting, being cancelled (still
# unwinding), or exited and not yet reaped. The one running ps is ``R``,
# and one paused or on a machine shows what it is doing.
STATES = {
    ProcessState.RUNNING: "S",
    ProcessState.STOPPING: "S",
    ProcessState.EXITED: "Z",
}


# Letters that select every process: SysV -e/-A/-a/-x, BSD a/x.
ALL = frozenset("eAax")
