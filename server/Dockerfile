#stage 1: build the react/vite frontend to static files
FROM node:22-slim AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

#stage 2: python runtime that serves the api + the built frontend
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
#the built SPA; main.py serves app/web when present (falling back to the static stub)
COPY --from=frontend /fe/dist ./app/web

#db lives on a mounted volume (see docker-compose.yml)
ENV CONTEXT_DB_PATH=/data/contextcreator.db
EXPOSE 8791

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8791"]
