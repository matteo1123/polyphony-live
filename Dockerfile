FROM node:20-alpine

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code and public files
COPY src ./src
COPY public ./public

# Expose port
EXPOSE 3000

# Start development server
CMD ["npm", "run", "dev"]
