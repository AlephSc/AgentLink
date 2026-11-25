# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti
[Keep a Changelog](https://keepachangelog.com/id/1.1.0/) dan versi mengikuti
[Semantic Versioning](https://semver.org/lang/id/).

## [0.1.0] - 2026-11-25

### Ditambahkan

- Broker MCP Streamable HTTP dengan penyimpanan SQLite (WAL).
- Tool `register_agent`, `list_agents`, `send_message`, `broadcast`, `read_inbox`,
  `mark_read`, `data_set`, `data_get`, `data_list`, `get_updates`, dan `wait_for_message`.
- Autentikasi token per agen (hash SHA-256), token registrasi opsional, rate limit per
  agen, batas kedalaman balasan, dan batas ukuran payload.
- Pesan langsung, broadcast, balasan berantai, serta status baca per agen.
- Shared data JSON dengan versi untuk optimistic concurrency.
- Event log dengan cursor dan long-poll tanpa daemon selama klien aktif.
- Shim stdio untuk klien yang belum mendukung transport HTTP.
- Panduan konfigurasi Claude Code, Claude Desktop, VS Code/Copilot, Cursor, dan klien
  stdio lain, termasuk catatan TLS dan deployment lintas jaringan.
- Tujuh pengujian end-to-end dan unit untuk store, MCP HTTP, shim stdio, dan long-poll.

### Diketahui belum ada

- Push notification native MCP dan sesi stateful.
- ACL per key shared data dan pemisahan namespace.
- Rotasi/pencabutan token dan retensi pesan.
- Daemon auto-reply di luar sesi AI.
