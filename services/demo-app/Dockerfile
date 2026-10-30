FROM node:22-alpine
WORKDIR /srv
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.cjs db-tunnel.cjs ./
USER node
EXPOSE 8080
CMD ["node", "server.cjs"]
