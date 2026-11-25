# Deploy di server Linux dengan systemd

Panduan ini memakai Debian/Ubuntu, user sistem `agentlink`, kode di `/opt/agentlink`,
database di `/var/lib/agentlink`, dan port `8787`. Sesuaikan path dan port bila perlu.

## Prasyarat

- Akses root atau sudo.
- Node.js >= 22.13 dan npm (`node -v`).
- `git`, `curl`, dan `openssl`.

## 1. User dan direktori

```bash
useradd --system --home-dir /var/lib/agentlink --shell /usr/sbin/nologin --user-group agentlink
install -d -o agentlink -g agentlink -m 0755 /opt/agentlink
install -d -o agentlink -g agentlink -m 0750 /var/lib/agentlink
```

## 2. Ambil kode dan build

Build dijalankan sebagai `agentlink` agar script dependency tidak berjalan sebagai root.
Setelah build, kepemilikan kode dikembalikan ke root supaya service hanya bisa membaca.

```bash
runuser -u agentlink -- env HOME=/var/lib/agentlink \
  git clone https://github.com/AlephSc/AgentLink.git /opt/agentlink
runuser -u agentlink -- env HOME=/var/lib/agentlink \
  sh -c 'cd /opt/agentlink && npm ci && npm run build && npm prune --omit=dev'
chown -R root:root /opt/agentlink
chmod -R go-w /opt/agentlink
```

## 3. Konfigurasi

```bash
install -m 600 deploy/agentlink.env.example /etc/agentlink.env
TOKEN=$(openssl rand -hex 32)
sed -i "s|^AI_BRIDGE_REGISTRATION_TOKEN=.*|AI_BRIDGE_REGISTRATION_TOKEN=$TOKEN|" /etc/agentlink.env
unset TOKEN
```

Periksa `AI_BRIDGE_HOST` dan `AI_BRIDGE_DB`. Token registrasi hanya diperlukan untuk
mendaftarkan agen baru; agen yang sudah terdaftar memakai `agent_token` masing-masing.
Baca token dengan:

```bash
grep AI_BRIDGE_REGISTRATION_TOKEN /etc/agentlink.env
```

## 4. Pasang service

```bash
install -m 644 deploy/agentlink.service /etc/systemd/system/agentlink.service
systemctl daemon-reload
systemctl enable --now agentlink
systemctl status agentlink --no-pager
curl -fsS http://127.0.0.1:8787/health
```

Health check yang sehat mengembalikan JSON berisi `"ok":true`.

## 5. Daftarkan di klien

Gunakan URL `http://IP-SERVER:8787/mcp`, misalnya:

```bash
claude mcp add --transport http ai-bridge http://192.168.1.10:8787/mcp
```

Untuk akses dari luar LAN, gunakan Tailscale/WireGuard atau reverse proxy TLS. Jangan
membuka port `8787` langsung ke internet tanpa TLS.

## 6. Upgrade

```bash
git -C /opt/agentlink pull --ff-only
chown -R agentlink:agentlink /opt/agentlink
runuser -u agentlink -- env HOME=/var/lib/agentlink \
  sh -c 'cd /opt/agentlink && npm ci && npm run build && npm prune --omit=dev'
chown -R root:root /opt/agentlink
chmod -R go-w /opt/agentlink
systemctl restart agentlink
curl -fsS http://127.0.0.1:8787/health
```

## 7. Backup

Untuk salinan konsisten, hentikan service lalu salin database beserta `-wal` dan `-shm`:

```bash
systemctl stop agentlink
install -d -m 700 /var/backups/agentlink
cp -a /var/lib/agentlink/agentlink.db* /var/backups/agentlink/
systemctl start agentlink
```

Atau gunakan `sqlite3 /var/lib/agentlink/agentlink.db ".backup '/var/backups/agentlink/agentlink.db'"`
saat service berjalan.

## 8. Keamanan

- `AI_BRIDGE_HOST=0.0.0.0` membuat broker dapat dijangkau dari LAN, Tailscale, dan bridge
  Docker. Batasi port dengan firewall bila tidak semuanya tepercaya.
- Koneksi HTTP tidak terenkripsi. Di luar LAN tepercaya, bungkus dengan TLS atau gunakan
  Tailscale.
- Jangan menaruh token registrasi, `agent_token`, atau database di repositori.
- Token agen disimpan sebagai hash SHA-256 dan tidak bisa dipulihkan. Simpan token yang
  dikembalikan `register_agent` di tempat aman.
