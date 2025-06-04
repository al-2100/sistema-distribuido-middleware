FROM node:18-slim

WORKDIR /usr/src/app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar TODAS las dependencias (necesarias para compilar TypeScript)
RUN npm install

# Copiar código fuente
COPY src ./src
COPY tsconfig.json ./
COPY config.json ./

# Compilar TypeScript
RUN npm run build

# Limpiar devDependencies después de compilar (opcional)
RUN npm prune --production

# Comando para ejecutar
CMD ["node", "dist/client.js"]