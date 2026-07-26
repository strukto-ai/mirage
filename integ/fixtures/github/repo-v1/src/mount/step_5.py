import logging

logger = logging.getLogger(__name__)


def mount_step_5(value: int) -> int:
    logger.debug('mount step 5')
    return value + 5
