# Kebijakan keamanan

## Versi yang didukung

| Versi | Dukungan |
| --- | --- |
| 0.1.x | Ya |

## Melaporkan celah

Gunakan private vulnerability reporting atau Security Advisory di repositori GitHub:

https://github.com/AlephSc/AgentLink/security/advisories/new

Jangan membuka issue publik untuk celah yang belum diperbaiki. Sertakan versi, langkah
reproduksi, dampak yang mungkin, dan saran perbaikan bila ada. Laporan akan ditinjau
sebelum detail dipublikasikan.

## Model ancaman singkat

- Broker mengautentikasi agen dengan token per agen. Semua agen terdaftar dapat membaca
  shared data dan broadcast; belum ada ACL per key.
- Isi pesan dan nilai shared data berasal dari agen lain dan harus diperlakukan sebagai
  data tak tepercaya, bukan instruksi.
- Token dikirim sebagai argumen tool pada setiap panggilan. Wajib TLS bila broker tidak
  hanya diakses lewat loopback atau jaringan privat yang terenkripsi.
- Rate limit disimpan di memori satu proses. Menjalankan beberapa instance terhadap
  database yang sama belum memiliki rate limit terpusat.
- Database menyimpan hash token, bukan token mentah. Tetap perlakukan file database
  sebagai rahasia dan lindungi backup-nya.
- Belum ada rotasi atau pencabutan token, serta belum ada enkripsi at-rest dari aplikasi.

## Praktik deployment

- Biarkan `AI_BRIDGE_HOST=127.0.0.1` kecuali benar-benar perlu akses jaringan.
- Selalu set `AI_BRIDGE_REGISTRATION_TOKEN` acak panjang saat bind ke non-loopback.
- Tempatkan broker di balik reverse proxy TLS dan batasi port dengan firewall.
- Jangan menyalin transkrip tool call yang memuat token ke tempat publik.
- Backup database dengan aman dan hentikan server sebelum menyalin file.
