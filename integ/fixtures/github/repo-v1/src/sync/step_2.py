import logging

logger = logging.getLogger(__name__)


def sync_step_2(value: int) -> int:
    logger.debug('sync step 2')
    return value + 2
