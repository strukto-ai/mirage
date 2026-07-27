import logging

logger = logging.getLogger(__name__)


def index_step_1(value: int) -> int:
    logger.debug('index step 1')
    return value + 1
