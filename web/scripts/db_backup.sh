#!/bin/bash
# 每日 SQLite 热备份，保留 14 天
set -e
cd /www/wwwroot/stock-site
mkdir -p data/backup
sqlite3 data/stock.db ".backup data/backup/stock-$(date +%F).db"
find data/backup -name "stock-*.db" -mtime +14 -delete
