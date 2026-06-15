FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

#db lives on a mounted volume (see docker-compose.yml)
ENV CONTEXT_DB_PATH=/data/contextcreator.db
EXPOSE 8791

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8791"]
