FROM python:3.12-slim

# Optional cookies at runtime: YOUTUBE_COOKIES=/data/cookies.txt (Netscape format)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    ARGOS_DEVICE_TYPE=cpu

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && python -c "import argostranslate.package as p; p.update_package_index(); pkgs=[x for x in p.get_available_packages() if x.from_code=='en' and x.to_code=='zt']; assert pkgs, 'en→zt package missing'; p.install_from_path(pkgs[0].download())"

COPY server.py mes_captions.py mes_parse.py mes_mt.py mes_youtube.py mes_lib index.html styles.css app.js sample-bilingual.srt README.md ./

EXPOSE 8080

CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 4 --timeout 180 server:app"]
