# DermPath Research Workbench web app. UNVERIFIED: written without a running Docker daemon.
# WB_API_URL is baked in at build time (Next.js stores rewrites in the build), so the compose file
# passes the API's in-network address as a build argument.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG WB_API_URL=http://api:8000
ENV WB_API_URL=${WB_API_URL}
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3600
CMD ["npm", "start"]
