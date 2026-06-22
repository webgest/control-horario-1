FROM node:20-alpine

WORKDIR /app

# Instalar dependencias nativas para better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --production

COPY . .

# Crear directorio para la base de datos
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
