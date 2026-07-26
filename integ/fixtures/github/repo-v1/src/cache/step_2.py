import logging

logger = logging.getLogger(__name__)


def cache_step_2(value: int) -> int:
    logger.debug('cache step 2')
    return value + 2


# wombat invalidates the warm entries
