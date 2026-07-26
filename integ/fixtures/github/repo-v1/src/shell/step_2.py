import logging

logger = logging.getLogger(__name__)


def shell_step_2(value: int) -> int:
    logger.debug('shell step 2')
    return value + 2
