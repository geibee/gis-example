#!/bin/sh
set -eu

target=${1:?証明書出力先が必要です}
umask 077
mkdir -p "$target"

if [ ! -f "$target/ca.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 7 \
    -subj "/CN=feedback-standalone-dev-ca" \
    -keyout "$target/ca.key" -out "$target/ca.crt"
fi

if [ ! -f "$target/broker.crt" ]; then
  openssl req -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=feedback-token-broker-reference" \
    -addext "subjectAltName=DNS:feedback-token-broker-reference,DNS:localhost" \
    -keyout "$target/broker.key" -out "$target/broker.csr"
  printf '%s\n' 'subjectAltName=DNS:feedback-token-broker-reference,DNS:localhost' >"$target/broker.ext"
  openssl x509 -req -sha256 -days 7 -in "$target/broker.csr" \
    -CA "$target/ca.crt" -CAkey "$target/ca.key" -CAcreateserial \
    -extfile "$target/broker.ext" -out "$target/broker.crt"
fi

if [ ! -f "$target/conformance-consumer.crt" ]; then
  openssl req -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=conformance-consumer" \
    -keyout "$target/conformance-consumer.key" -out "$target/conformance-consumer.csr"
  openssl x509 -req -sha256 -days 7 -in "$target/conformance-consumer.csr" \
    -CA "$target/ca.crt" -CAkey "$target/ca.key" -CAcreateserial \
    -out "$target/conformance-consumer.crt"
fi

if [ ! -f "$target/signing-private.pem" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$target/signing-private.pem"
  openssl pkey -in "$target/signing-private.pem" -pubout -out "$target/signing-public.pem"
fi

chmod 600 "$target"/*.key "$target"/*-private.pem 2>/dev/null || true
chmod 644 "$target"/*.crt "$target"/*-public.pem
chown -R 1000:1000 "$target"
