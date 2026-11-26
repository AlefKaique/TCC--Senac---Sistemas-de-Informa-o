<?php

namespace Hydra\Support;

/**
 * A categoria já usou os 1.000 SKUs da sua faixa na filial
 * (SkuRepository::proximo). A mensagem é para o usuário.
 */
final class LimiteSkuException extends \RuntimeException
{
}
