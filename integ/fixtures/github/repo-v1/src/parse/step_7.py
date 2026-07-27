import logging

logger = logging.getLogger(__name__)


def parse_step_7(value: int) -> int:
    logger.debug('parse step 7')
    return value + 7
