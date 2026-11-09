# The live processes a session holds when no block names a cap: at the
# 125 to 235 KiB each one costs, about what `max_memory`'s 32 MB default
# holds, so a fork bomb meets the cap before it meets the host's memory.
from mirage.shell.constants import CONTINUE_SIGNALS, STOP_SIGNALS

MAX_PROCESSES = 128

# Mirage numbers its processes past 4194304, the most pids a Linux kernel
# hands out (2**22), so a number at or under it names a machine's process
# and a number above it a Mirage one, wherever either is written.
FIRST_PID = 4194305

# Signals a running process takes and goes on: those whose default is to
# ignore them, the terminal stops a non-interactive bash's asynchronous
# commands ignore, and STOP and CONT, which pause one and let it go on.
KEPT_SIGNALS = CONTINUE_SIGNALS | STOP_SIGNALS

# What ``ps`` names as the machine of whatever Mirage runs itself, which
# ``kill -m`` and ``wait -m`` take too.
WORKSPACE_MACHINE = "mirage"
