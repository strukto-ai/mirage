import logging

logger = logging.getLogger(__name__)


def codec_step_4(value: int) -> int:
    logger.debug('codec step 4')
    return value + 4
