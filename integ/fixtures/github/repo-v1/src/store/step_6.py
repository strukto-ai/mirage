import logging

logger = logging.getLogger(__name__)


def store_step_6(value: int) -> int:
    logger.debug('store step 6')
    return value + 6
