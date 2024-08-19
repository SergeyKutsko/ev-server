#!/bin/sh
nginx -g 'daemon on;'
pm2-runtime dist/start.js
