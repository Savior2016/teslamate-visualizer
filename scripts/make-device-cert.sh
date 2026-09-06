#!/bin/sh
# 生成设备证书免密体系:设备 CA + iPhone 客户端证书(p12)。
#   ./scripts/make-device-cert.sh           首次生成(已有 CA 时不覆盖)
#   ./scripts/make-device-cert.sh --new-ca  吊销全部旧设备:删 CA 重签(旧证书立即失效)
# 产物都在 data/pki/(0700,gitignored,与 fleet 凭据同级保密)。
set -eu

PKI="$(cd "$(dirname "$0")/.." && pwd)/data/pki"
mkdir -p "$PKI"; chmod 700 "$PKI"

if [ "${1:-}" = "--new-ca" ]; then
    rm -f "$PKI/device-ca.key" "$PKI/device-ca.crt"
    echo "已删除旧 CA,全部旧设备证书随之失效"
fi

if [ ! -f "$PKI/device-ca.key" ]; then
    # 设备 CA:EC P-256,10 年
    openssl ecparam -genkey -name prime256v1 -out "$PKI/device-ca.key"
    openssl req -new -x509 -key "$PKI/device-ca.key" -sha256 -days 3650 \
        -subj "/CN=tesla-home device CA" -out "$PKI/device-ca.crt"
    echo "已生成设备 CA(10 年)"
else
    echo "沿用已有设备 CA"
fi

# iPhone 客户端证书:EC P-256,2 年;重复运行即重签(旧证随 CA 不变仍有效,换机时用 --new-ca)
openssl ecparam -genkey -name prime256v1 -out "$PKI/iphone.key"
openssl req -new -key "$PKI/iphone.key" -subj "/CN=iphone" -out "$PKI/iphone.csr"
printf 'extendedKeyUsage = clientAuth\nkeyUsage = digitalSignature\n' > "$PKI/iphone.ext"
openssl x509 -req -in "$PKI/iphone.csr" -CA "$PKI/device-ca.crt" -CAkey "$PKI/device-ca.key" \
    -CAcreateserial -sha256 -days 730 -extfile "$PKI/iphone.ext" -out "$PKI/iphone.crt"
rm -f "$PKI/iphone.csr" "$PKI/iphone.ext"

# p12 导出密码:首次生成并落盘,之后沿用(换密码 iPhone 端要重装)
if [ ! -f "$PKI/EXPORT_PASSWORD.txt" ]; then
    openssl rand -hex 8 > "$PKI/EXPORT_PASSWORD.txt"
    chmod 600 "$PKI/EXPORT_PASSWORD.txt"
fi
openssl pkcs12 -export -inkey "$PKI/iphone.key" -in "$PKI/iphone.crt" \
    -certfile "$PKI/device-ca.crt" -name "TESLA Home iPhone" \
    -passout "file:$PKI/EXPORT_PASSWORD.txt" -out "$PKI/iphone.p12"

chmod 600 "$PKI/device-ca.key" "$PKI/iphone.key" "$PKI/iphone.p12"
chmod 644 "$PKI/device-ca.crt" "$PKI/iphone.crt"
echo "完成:$PKI/iphone.p12(导出密码见 $PKI/EXPORT_PASSWORD.txt)"
