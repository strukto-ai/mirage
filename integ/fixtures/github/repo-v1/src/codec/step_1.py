import logging

logger = logging.getLogger(__name__)


def codec_step_1(value: int) -> int:
    logger.debug('codec step 1')
    return value + 1
