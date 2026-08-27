FROM php:8.2-apache

RUN docker-php-ext-install pdo pdo_mysql \
	&& a2enmod rewrite

COPY Hydra.Front/ /var/www/html/
COPY Hydra.Back/src/ /var/www/html/src/
COPY Hydra.Back/config/ /var/www/html/config/

RUN mkdir -p /var/www/html/api
COPY Hydra.Back/public/index.php /var/www/html/api/index.php

RUN chown -R www-data:www-data /var/www/html

EXPOSE 80
