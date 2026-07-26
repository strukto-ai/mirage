import logging

logger = logging.getLogger(__name__)


def sync_step_7(value: int) -> int:
    logger.debug('sync step 7')
    return value + 7
