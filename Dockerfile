FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js .
COPY middleware/ ./middleware/
COPY routes/ ./routes/
COPY services/ ./services/
COPY firmware_files/ /firmware/
EXPOSE 8080
CMD ["node", "server.js"]
