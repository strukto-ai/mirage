import logging

logger = logging.getLogger(__name__)


def mount_step_2(value: int) -> int:
    logger.debug('mount step 2')
    return value + 2
