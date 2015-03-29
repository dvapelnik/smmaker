#!/bin/sh

sudo apt-get update

sudo apt-get install -y git
sudo apt-get install -y mc

sudo apt-get install nodejs npm libfontconfig -y
cd /usr/bin/ && sudo ln -s nodejs node

sudo npm install -g bower
cd /var/www/html && sudo bower update --allow-root

cd /var/www/html && npm update

cat /etc/shadow | grep vagrant

#cd /var/www/html && npm run start
cd /var/www/html && npm run supervisor
