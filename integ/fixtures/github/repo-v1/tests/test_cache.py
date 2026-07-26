from src.cache.step_1 import cache_step_1


def test_cache_step_1() -> None:
    assert cache_step_1(1) == 2
