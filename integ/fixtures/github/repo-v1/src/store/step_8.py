import logging

logger = logging.getLogger(__name__)


def store_step_8(value: int) -> int:
    logger.debug('store step 8')
    return value + 8
