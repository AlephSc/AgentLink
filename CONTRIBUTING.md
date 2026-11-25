# Kontribusi

Terima kasih sudah ingin membantu AgentLink. Panduan ini singkat: siapkan lingkungan,
jalankan pengujian, lalu buka pull request yang fokus.

## Menyiapkan lingkungan

```bash
npm install
npm run build
npm test
```

Butuh Node.js >= 22.13 karena proyek memakai modul bawaan `node:sqlite`. Untuk mencoba
server secara lokal: `npm run dev` atau `npm start` setelah build.

## Struktur perubahan

- `src/store.ts` — skema, migrasi, dan query SQLite. Tidak berisi aturan HTTP.
- `src/broker.ts` — autentikasi, rate limit, aturan balasan, dan long-poll. Setiap mutasi
  harus memicu event `change` agar long-poll terbangun.
- `src/mcp.ts` — definisi tool, schema Zod, dan deskripsi untuk model. Jangan pernah
  mencatat token atau isi pesan ke log.
- `src/http.ts`, `src/shim.ts`, `src/index.ts` — transport dan entry point.
- `test/` — pengujian store dan MCP end-to-end memakai `node:test`.

Menambah tool baru berarti: implementasi di store/broker, schema di `mcp.ts`, pengujian di
`test/mcp.test.mjs`, dan dokumentasi di `README.md` serta `CHANGELOG.md`.

## Gaya

- TypeScript strict, ESM, indentasi 2 spasi.
- Hindari `any` baru; gunakan tipe eksplisit atau `unknown` dengan validasi.
- Pesan error publik memakai `BridgeError` dengan kode yang sudah ada.
- Jangan menambah dependensi tanpa alasan yang jelas dan tanpa menjalankan `npm audit`.

## Pull request

1. Pastikan `npm test` lulus dan `npm audit` bersih.
2. Jelaskan perilaku yang berubah, bukan hanya file yang disentuh.
3. Sertakan contoh panggilan tool untuk perubahan yang terlihat oleh agen.
4. Jangan menyertakan token, database, file `.env`, atau data agen nyata.

## Kode etik dan keamanan

Semua partisipan tunduk pada [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Jangan membuka
issue publik untuk celah keamanan; ikuti [SECURITY.md](SECURITY.md).
