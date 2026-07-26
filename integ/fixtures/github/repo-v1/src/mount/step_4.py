import logging

logger = logging.getLogger(__name__)


def mount_step_4(value: int) -> int:
    logger.debug('mount step 4')
    return value + 4
