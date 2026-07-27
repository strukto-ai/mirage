import logging

logger = logging.getLogger(__name__)


def route_step_4(value: int) -> int:
    logger.debug('route step 4')
    return value + 4
