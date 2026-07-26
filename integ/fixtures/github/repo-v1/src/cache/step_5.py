import logging

logger = logging.getLogger(__name__)


def cache_step_5(value: int) -> int:
    logger.debug('cache step 5')
    return value + 5
