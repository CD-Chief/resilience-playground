FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
# The bad-deploy image is this same build with BROKEN=true baked in.
ARG VERSION=dev
ARG BROKEN=false
ENV NODE_ENV=production \
    VERSION=$VERSION \
    BROKEN=$BROKEN
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080 9090
CMD ["node", "dist/index.js"]
