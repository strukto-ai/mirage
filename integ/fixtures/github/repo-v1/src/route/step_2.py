import logging

logger = logging.getLogger(__name__)


def route_step_2(value: int) -> int:
    logger.debug('route step 2')
    return value + 2
