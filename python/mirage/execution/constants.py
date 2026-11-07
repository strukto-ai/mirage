from mirage.execution.types import MachineId

# Where a process runs when nothing names its machine: the machine the
# workspace itself runs on, before the host gives its name.
LOCAL_MACHINE = MachineId("host", "localhost")

# The ended records a table keeps: the newest of them, for at most an hour.
HISTORY_MAX_RECORDS = 1024
HISTORY_SECONDS = 3600.0

# What a line a cancel or an abort stopped ends with: an interrupt, as a
# shell's line ends on ^C.
LINE_STOP_SIGNAL = 2
