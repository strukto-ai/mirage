from mirage.execution.types import MachineId

# Where a process runs when nothing names its machine: the machine the
# workspace itself runs on, before the host gives its name.
LOCAL_MACHINE = MachineId("host", "localhost")
