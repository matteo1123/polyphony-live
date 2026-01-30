#!/bin/sh
set -e

# Start Redis
redis-server /etc/redis.conf --daemonize yes

# Wait for Redis
until redis-cli ping 2>/dev/null | grep -q PONG; do
  sleep 0.2
done

# Start Node.js (exec replaces shell so signals work)
exec npm start
