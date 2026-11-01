FROM node:26-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY demo/sales ./demo/sales
COPY aws/sales ./aws/sales
USER node
EXPOSE 8080
CMD ["node", "aws/sales/runtime.ts", "app"]
