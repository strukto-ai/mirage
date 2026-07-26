import logging

logger = logging.getLogger(__name__)


def shell_step_1(value: int) -> int:
    logger.debug('shell step 1')
    return value + 1
