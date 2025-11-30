# Use an official Node.js image.
FROM node:24-alpine

# Create and change to the app directory.
WORKDIR /app

# Copy application dependency manifests to the container image.
COPY package*.json ./

# Install all dependencies, including devDependencies for the dev server.
# Use npm ci for reproducible builds that match package-lock.json exactly
RUN npm ci

# Copy local code to the container image.
COPY . .

# Expose both the client and server ports.
EXPOSE 3000 3001

# Run the dev service on container startup.
CMD ["npm", "run", "dev"]
