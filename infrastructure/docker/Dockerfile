FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps ./apps
COPY integrations ./integrations
COPY tsconfig.base.json tsconfig.json ./
RUN npm install --ignore-scripts
RUN npm run build:dashboard

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/integrations ./integrations
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
VOLUME ["/data"]
ENV MODELFORGE_DATA_DIR=/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["./node_modules/.bin/tsx", "apps/gateway/src/index.ts"]
