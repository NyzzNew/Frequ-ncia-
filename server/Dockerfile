FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server.mjs schema.sql ./
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]
