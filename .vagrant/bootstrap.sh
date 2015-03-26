#!/bin/sh

DB_ROOT_USER="root"
DB_ROOT_PASS="nopass"
DBNAME="smmaker"
DBDUMP="/var/www/html/.vagrant/db.sql"

sudo apt-get update

sudo apt-get install -y curl openssl git mc

echo mysql-server mysql-server/root_password password ${DB_ROOT_PASS} | sudo debconf-set-selections
echo mysql-server mysql-server/root_password_again password ${DB_ROOT_PASS} | sudo debconf-set-selections

sudo apt-get install lamp-server^ php5-curl -y

if [ ! -f /var/log/dbinstalled ];
then
    echo "CREATE DATABASE IF NOT EXISTS $DBNAME" | mysql -u${DB_ROOT_USER} -p${DB_ROOT_PASS}
    echo "CREATE USER '$DBNAME'@'$DBNAME' IDENTIFIED BY '$DBNAME'" | mysql -u${DB_ROOT_USER} -p${DB_ROOT_PASS}
    echo "GRANT ALL PRIVILEGES ON $DBNAME.* TO '$DBNAME'@'$DBNAME' IDENTIFIED BY '$DBNAME'" | mysql -u${DB_ROOT_USER} -p${DB_ROOT_PASS}
    echo "GRANT ALL ON $DBNAME.* TO '$DBNAME'@'localhost'" | mysql -u${DB_ROOT_USER} -p${DB_ROOT_PASS}
    echo "flush privileges" | mysql -u${DB_ROOT_USER} -p${DB_ROOT_PASS}

    touch /var/log/dbinstalled

    if [ -f "$DBDUMP" ];
    then
        mysql -u${DB_ROOT_USER} -p${DB_ROOT_PASS} ${DBNAME} < ${DBDUMP}
    fi
fi

sudo rm -f /etc/apache2/sites-enabled/000-default.conf
sudo ln -s /var/www/html/.vagrant/httpd.conf /etc/apache2/sites-enabled/000-default.conf

sudo rm -f /etc/apache2/envvars
sudo cp /var/www/html/.vagrant/envvars /etc/apache2/envvars

sudo service apache2 restart
sudo service mysql restart

#curl -s https://getcomposer.org/installer | php
#mv composer.phar /usr/local/bin/composer
#chmod +x /usr/local/bin/composer

sudo apt-get install nodejs npm libfontconfig -y

sudo npm install -g bower casperjs phantomjs

cd /usr/bin/ && sudo ln -s nodejs node
cd /var/www/html && sudo bower update --allow-root
cd /usr/local/bin && \
    sudo ln -s /usr/local/lib/node_modules/casperjs/node_modules/phantomjs/bin/phantomjs phantomjs
cd /var/www/html/server/ && sudo -u vagrant npm update

cd /var/www/html && npm run start
#cd /var/www/html && npm run supervisor
