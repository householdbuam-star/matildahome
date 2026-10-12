FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
ENV MODEL_DIR=/app/models
COPY server ./server
COPY public ./public
COPY scripts ./scripts
# Prefetch the MobileNet model so Snap to find works without outbound internet at runtime.
RUN node --no-warnings=ExperimentalWarning -e "import('./server/vision/embedder.js').then(m => m.getModel()).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); })" \
    && test -f /app/models/mobilenet/model.json
ENV PORT=3000 DATA_DIR=/data MODEL_DIR=/app/models TRUST_PROXY=1
VOLUME ["/data"]
EXPOSE 3000
CMD ["npm", "start"]
