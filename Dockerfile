FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# 与 deploy.ps1 一致：静态页与根目录资源须一并打入镜像，否则 Docker 部署缺页
COPY server.js ./
COPY admin.html director.html canvas.html logo.png ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
