# Use official Node.js LTS slim image
FROM node:20-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY index.js ./

# Cloud Run Jobs run the container to completion
CMD ["node", "index.js"]
