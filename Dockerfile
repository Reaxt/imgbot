FROM node as build

WORKDIR /app
COPY . .
RUN npm install
RUN npx tsc

FROM node:alpine

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY --from=build /app/dist .
ENTRYPOINT ["node", "dist/index.js"]
