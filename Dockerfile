FROM python:3.12-slim

# PGDG 源的 postgresql-client-18(与数据库服务器大版本对齐,pg_dump/pg_restore 用;
# Debian 自带源版本过旧无法导出 PG18)
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
 && echo "deb http://apt.postgresql.org/pub/repos/apt trixie-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
 && wget -qO- https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN groupadd --gid 1000 panel && useradd --uid 1000 --gid panel --no-create-home panel
USER 1000:1000
ENV DISPLAY_TZ=Asia/Shanghai
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-proxy-headers", "--no-access-log"]
