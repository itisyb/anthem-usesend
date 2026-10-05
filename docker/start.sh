#!/bin/sh
set -eu

# Schema changes are an explicit release operation. Use the Prisma version
# installed in this image; do not download another version at startup.
if [ "${RUN_DATABASE_MIGRATIONS:-false}" = "true" ]; then
  node node_modules/prisma/build/index.js migrate deploy --schema ./apps/web/prisma/schema.prisma
else
  node node_modules/prisma/build/index.js migrate status --schema ./apps/web/prisma/schema.prisma
fi

exec node apps/web/server.js
