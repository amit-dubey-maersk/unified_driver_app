# syntax=docker/dockerfile:1

# Stage 1: install production dependencies
FROM node:24-alpine AS builder
WORKDIR /app
COPY --link package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Stage 2: runtime
FROM node:24-alpine
WORKDIR /app
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src ./src


# Folder + embedded-DB working dirs must be writable by the non-root user.
RUN mkdir -p /app/edi214 /app/events /app/data/pglite && chown -R node:node /app/edi214 /app/events /app/data

# non-root (node user, UID 1000) - same as the reference service
USER 1000

# 8081 = app/API, 44421 = /health + /prometheus
EXPOSE 8081 44421

ENTRYPOINT ["node", "src/index.js"]
