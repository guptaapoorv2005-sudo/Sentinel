# Sentinel Backend Dockerfile
#
# Multi-stage build:
# Stage 1 (deps): Install only production dependencies
# Stage 2 (app): Copy source code and run
#
# WHY MULTI-STAGE:
# The final image doesn't contain devDependencies (like prisma CLI,
# pino-pretty, nodemon). This makes the image smaller and more secure.

# --- Stage 1: Install dependencies ---
FROM node:22-alpine AS deps

WORKDIR /app

# Copy package files first (Docker layer caching).
# If package.json hasn't changed, Docker reuses the cached layer
# and skips npm install. This is a big time saver during development.
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# --- Stage 2: Application ---
FROM node:22-alpine

WORKDIR /app

# Copy production dependencies from Stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Generate Prisma client inside the container
# (The generated client is platform-specific, so we regenerate here)
RUN npx prisma generate

# The API listens on this port
EXPOSE 8000

# Start the server
CMD ["node", "src/index.js"]
