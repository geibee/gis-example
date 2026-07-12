FROM ghcr.io/osgeo/gdal:ubuntu-full-3.9.2

WORKDIR /app

# ベースイメージ同梱の Apache Arrow apt リポジトリは鍵ローテーションで apt-get update を
# 壊すことがある (NO_PUBKEY)。このイメージでは Arrow パッケージを追加しないため除去する
RUN rm -f /etc/apt/sources.list.d/apache-arrow.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3-pip \
    && rm -rf /var/lib/apt/lists/*

# 本番イメージには実行時依存のみを入れる (moto 等のテスト専用依存を焼き込まない)
COPY requirements-runtime.txt .
RUN pip3 install --break-system-packages --no-cache-dir -r requirements-runtime.txt

COPY src ./src

CMD ["python3", "-m", "src.worker"]
