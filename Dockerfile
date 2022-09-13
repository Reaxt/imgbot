FROM node as build

WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN npx tsc

FROM node:alpine

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
