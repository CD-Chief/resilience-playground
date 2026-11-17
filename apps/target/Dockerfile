FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
# The bad-deploy images are this same build with a fault baked in:
# BROKEN=true never becomes ready; ERROR_RATE=0.5 is ready but fails half its requests.
ARG VERSION=dev
ARG BROKEN=false
ARG ERROR_RATE=0
ENV NODE_ENV=production \
    VERSION=$VERSION \
    BROKEN=$BROKEN \
    ERROR_RATE=$ERROR_RATE
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080 9090
CMD ["node", "dist/index.js"]
