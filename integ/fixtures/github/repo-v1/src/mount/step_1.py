import logging

logger = logging.getLogger(__name__)


def mount_step_1(value: int) -> int:
    logger.debug('mount step 1')
    return value + 1
