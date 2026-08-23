FROM node:20-alpine
RUN apk add --no-cache openssh-keygen
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV PORT=80
EXPOSE 80
CMD ["node", "server.js"]
