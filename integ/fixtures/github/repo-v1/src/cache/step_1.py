import logging

logger = logging.getLogger(__name__)


def cache_step_1(value: int) -> int:
    logger.debug('cache step 1')
    return value + 1
