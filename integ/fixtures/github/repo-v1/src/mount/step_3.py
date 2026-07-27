import logging

logger = logging.getLogger(__name__)


def mount_step_3(value: int) -> int:
    logger.debug('mount step 3')
    return value + 3
