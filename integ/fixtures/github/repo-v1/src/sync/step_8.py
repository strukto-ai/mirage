import logging

logger = logging.getLogger(__name__)


def sync_step_8(value: int) -> int:
    logger.debug('sync step 8')
    return value + 8
