# Guildhood authoritative game server. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t guildhood-game .
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm run build -w apps/server

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN npm ci --omit=dev --workspace=@guildhood/server --ignore-scripts && npm cache clean --force
COPY --from=build /repo/apps/server/dist apps/server/dist
USER node
EXPOSE 2567
HEALTHCHECK --interval=15s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
