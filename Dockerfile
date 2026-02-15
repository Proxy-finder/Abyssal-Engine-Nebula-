FROM node:18-slim

# Install Chromium and dependencies
RUN apt-get update && apt-get install -y \
    chromium-browser \
    ca-certificates \
    fonts-noto \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV CHROME_BIN=/usr/bin/chromium-browser
ENV PORT=8000

EXPOSE 8000

CMD ["npm", "start"]
