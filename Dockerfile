# Single image, run as three different containers (API server, async
# consumer, telemetry consumer) via different commands -- see
# docker-compose.yml. No build step needed (plain JS, no TypeScript/bundling).
FROM node:20-alpine

WORKDIR /app

# Copy only the manifest first, so Docker can cache the npm install layer --
# rebuilding after a source change won't re-run npm install unless
# package.json itself changed.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Now copy the actual application code.
COPY src/ ./src/

# Documentation only -- doesn't actually publish the port by itself, that
# still happens in docker-compose.yml or `docker run -p`.
EXPOSE 4000

# Default command: the API server. The two consumer containers override
# this with `command:` in docker-compose.yml, using the exact same image.
CMD ["node", "src/index.js"]
