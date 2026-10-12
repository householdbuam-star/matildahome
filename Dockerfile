FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY scripts ./scripts
ENV PORT=3000 DATA_DIR=/data TRUST_PROXY=1
VOLUME ["/data"]
EXPOSE 3000
CMD ["npm", "start"]
