# CF Containers require linux/amd64. Debian trixie = glibc 2.41 (XMTP's native addon needs >=2.38;
# bookworm's 2.36 is too old). ca-certificates is required or XMTP's gRPC/TLS fails.
FROM --platform=linux/amd64 node:22-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app/package.json ./
# Install, then drop every prebuilt native binding EXCEPT linux-x64-gnu (the only one this
# glibc/amd64 container runs). @xmtp/node-bindings ships ~7 platforms × 2 copies (~300MB of dead
# weight) which otherwise bloats the image and stalls the registry push.
RUN npm install --no-audit --no-fund --omit=dev --loglevel=error \
  && find node_modules -name "bindings_node.*.node" ! -name "*linux-x64-gnu*" -delete \
  && npm cache clean --force 2>/dev/null || true
COPY app/*.mjs ./
RUN mkdir -p /data

EXPOSE 8080
# --experimental-sqlite enables the built-in node:sqlite (used to VACUUM INTO a clean DB snapshot).
CMD ["node", "--experimental-sqlite", "index.mjs"]
