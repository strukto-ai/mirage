import logging

logger = logging.getLogger(__name__)


def shell_step_3(value: int) -> int:
    logger.debug('shell step 3')
    return value + 3
