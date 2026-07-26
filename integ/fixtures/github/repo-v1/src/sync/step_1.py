import logging

logger = logging.getLogger(__name__)


def sync_step_1(value: int) -> int:
    logger.debug('sync step 1')
    return value + 1
