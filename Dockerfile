FROM php:8.2-apache

RUN docker-php-ext-install pdo pdo_mysql \
	&& a2enmod rewrite \
	&& sed -i 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf

# A imagem oficial nao ativa nenhum php.ini; sem isso o PHP assume
# display_errors=On e devolve mensagens de erro (com caminhos internos
# do servidor) direto no navegador do visitante.
RUN mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

# Apenas o front-end fica na raiz publica do Apache.
COPY Hydra.Front/ /var/www/html/
# O codigo PHP fica FORA de /var/www/html. Antes ele era copiado para
# /var/www/html/src e /var/www/html/config, o que tornava arquivos como
# /config/database.php enderecaveis pelo navegador - qualquer falha no
# handler de PHP passaria a servir o codigo-fonte como texto.
COPY Hydra.Back/src/ /var/www/app/src/
COPY Hydra.Back/config/ /var/www/app/config/

RUN mkdir -p /var/www/html/api
COPY Hydra.Back/public/index.php /var/www/html/api/index.php

RUN chown -R www-data:www-data /var/www/html /var/www/app

EXPOSE 80
