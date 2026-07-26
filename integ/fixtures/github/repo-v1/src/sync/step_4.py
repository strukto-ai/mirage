import logging

logger = logging.getLogger(__name__)


def sync_step_4(value: int) -> int:
    logger.debug('sync step 4')
    return value + 4
