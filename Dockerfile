FROM node:25

WORKDIR /app

COPY package.json /app

RUN npm install

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PORT=80

EXPOSE $PORT

CMD ["node", "build/index.js"]