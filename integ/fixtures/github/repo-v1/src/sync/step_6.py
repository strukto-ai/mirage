import logging

logger = logging.getLogger(__name__)


def sync_step_6(value: int) -> int:
    logger.debug('sync step 6')
    return value + 6
