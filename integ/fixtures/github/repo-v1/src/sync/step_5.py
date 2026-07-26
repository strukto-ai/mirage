import logging

logger = logging.getLogger(__name__)


def sync_step_5(value: int) -> int:
    logger.debug('sync step 5')
    return value + 5
