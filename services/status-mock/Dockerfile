FROM node:22-alpine
WORKDIR /srv
COPY server.cjs ./
USER node
EXPOSE 8081
CMD ["node", "server.cjs"]
