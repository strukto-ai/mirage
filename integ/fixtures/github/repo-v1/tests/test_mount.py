from src.mount.step_1 import mount_step_1


def test_mount_step_1() -> None:
    assert mount_step_1(1) == 2
