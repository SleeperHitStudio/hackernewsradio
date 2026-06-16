# hackernewsradio — multi-stage build.
# Build stage compiles the Vite/React frontend; runtime ships only the server +
# prod deps + built assets.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/web/dist ./web/dist
# The JSON drama index lives here; mount a volume to persist across restarts.
RUN mkdir -p /app/data
EXPOSE 8080
CMD ["node", "server/index.mjs"]
