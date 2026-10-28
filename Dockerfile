FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN CHORAL_BUILD_BASE=/ VITE_APP_DEMO=false npm run build

FROM golang:1.27.3-bookworm@sha256:05237276236793ebedaf0b87dab86add9ec9adc66ebef2dbc3107c18254cde1c AS backend
WORKDIR /src
ENV GOTOOLCHAIN=local CGO_ENABLED=0
COPY backend/go.mod backend/go.sum ./
RUN go mod download && go mod verify
COPY backend/ ./
RUN go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /out/choral-server ./cmd/server && \
    go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /out/choral-accounts ./cmd/accounts

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
# Immutable repository date; retain TLS, signed Release and package checksums.
RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf '%s\n' 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261027T000000Z bookworm main' > /etc/apt/sources.list && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg util-linux sqlite3 && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir /data /app && chown 10001:10001 /data && chmod 700 /data
COPY --from=backend /out/ /usr/local/bin/
COPY --from=frontend /src/dist/ /app/
COPY --chmod=755 scripts/container-data.sh /usr/local/bin/choral-data
USER 10001:10001
ENV CHORAL_ADDR=0.0.0.0:8080 CHORAL_DATA_DIR=/data CHORAL_STATIC_DIR=/app CHORAL_SHUTDOWN_TIMEOUT=15s
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 CMD ["choral-server", "healthcheck"]
ENTRYPOINT ["choral-server"]
