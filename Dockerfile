FROM python:3.12-slim

WORKDIR /app

COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY index.html styles.css ./
COPY js ./js
COPY maps ./maps
COPY dist ./dist
COPY server ./server

ENV HOST=0.0.0.0
ENV PORT=8765
ENV MAX_FILE_MB=60

EXPOSE 8765

CMD ["python", "server/server.py"]
