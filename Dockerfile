# radio.cn 签名代理 —— 纯标准库, 无需 pip 依赖
ARG BASE_IMAGE=python:3.12-alpine
FROM ${BASE_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8090 \
    API_BASE=https://ytmsout.radio.cn

WORKDIR /app
COPY app.py /app/app.py

RUN adduser -D -H -u 10001 app && chown -R app:app /app
USER app

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/healthz'%os.environ.get('PORT','8090'),timeout=5)"

CMD ["python", "/app/app.py"]
