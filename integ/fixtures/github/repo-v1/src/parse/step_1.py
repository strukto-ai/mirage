import logging

logger = logging.getLogger(__name__)


def parse_step_1(value: int) -> int:
    logger.debug('parse step 1')
    return value + 1
