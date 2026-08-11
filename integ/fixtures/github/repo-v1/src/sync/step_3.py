import logging

logger = logging.getLogger(__name__)


def sync_step_3(value: int) -> int:
    logger.debug('sync step 3')
    return value + 3
