# Shelfline — breakdown

> Nama sebelumnya "Gerai"; diganti 2026-11-04 agar bernama global. Pencarian kategori POS tidak menemukan produk bernama Shelfline, tetapi itu bukan pemeriksaan merek dagang; cek sebelum dipakai publik.

**Satu kalimat:** platform manajemen retail dan POS multi-lokasi: POS iPad yang tetap menjual saat offline, stok per lokasi sebagai buku besar, absen sidik jari terminal yang terhubung ke POS, komisi per kasir, izin laporan per pengguna/lokasi/rentang waktu, dan laporan akhir hari otomatis. Proyek #8 portfolio; acuan: lowongan Upwork gabungan Shopify + Lightspeed. Demo: "Kestrel Run Co." (fiktif, sepatu lari, 4 toko + 1 gudang, AUD).

**Status:** paket dokumen + desain selesai (2026-11-04). **M1–M8 selesai (seluruh fase P1, demo berjalan dari kloning bersih)** (fondasi + auth; katalog, pajak, `pricing`, CSV; ledger stok; mesin sinkron; **POS iPad PWA: jual, bayar, offline, diskon berizin, pelanggan, parkir**, kas, refund, tutup register dengan hitung buta, laporan Z, clock in/out; E2E POS 16/16 dan admin 10/10 di Chrome; **admin: Today live, lensa lokasi, Orders, Customers, Products, Inventory, Staff, Reports, Locations, Audit**). Belum diuji di iPad/Safari nyata (tidak ada perangkat). Soak 10 kasir × 500 penjualan + putar ulang dengan checksum identik; seed demo Kestrel Run Co. (904 varian, 90 hari); layar Sync, ekspor antrean, layar Update required; E2E POS 17/17. P1 selesai; P2 (operasi toko) dimulai dari M9 (pembelian dan keuangan vendor). Tanpa estimasi waktu/biaya (proyek sendiri); fase berdasarkan ketergantungan.

## Fase
- **P1 inti penjualan (F1–F13, M1–M8):** organisasi/lokasi/peran, katalog, ledger stok, mesin sinkron, POS jual/bayar, register/kas/refund, admin dasar, offline.
- **P2 operasi toko (F14–F28, M9–M19):** pembelian + keuangan vendor, transfer, stock count, price book, gift card/kredit, jadwal + timesheet, absen sidik jari + jembatan Go, komisi, izin laporan + portal, notifikasi, laporan akhir hari, perangkat keras + Capacitor + kartu.
- **P3 pertumbuhan (F29–F35, M20–M24):** toko online, channel Shopify, marketing automation + loyalti, ekspor akuntansi + replenishment, pengerasan.

## Keputusan utama (alasan di TECH-SPEC)
1. **Stack:** NestJS modular monolith + PostgreSQL dipertahankan. **Redis/BullMQ ditolak** (outbox + `scheduled_job` di Postgres, atomik dengan data). **POS dan admin diubah dari Next.js ke Vite + React** (aplikasi tanpa SSR; POS harus hidup tanpa server); Next.js hanya untuk storefront P3. **Go dipakai untuk jembatan perangkat** (biner statis di perangkat toko non-teknis).
2. **Offline:** POS menyimpan replika baca + antrean perintah tak berubah (UUIDv7, idempoten), tarik berbasis kursor aman-transaksi. Server tidak menolak fakta fisik: anomali diterima dan ditandai (stok negatif, harga beda, refund berlebih, jam melenceng). Matriks konflik per jenis data di §5.1. Gift card/kredit offline mati secara default.
3. **Absen sidik jari:** terminal absensi jaringan + bridge LAN; template tidak pernah keluar dari terminal. Aplikasi native + USB ditolak (iOS tak punya WebUSB; SDK tak diverifikasi); WebAuthn iPad ditolak (tak bisa mengatribusikan ke karyawan pada iPad bersama).
4. **Stok:** ledger `stock_movement` append-only per (varian, lokasi), proyeksi saldo, lokasi transit, stock count sebagai delta, stok negatif diizinkan dan ditandai .
5. **Komisi:** aturan berversi, entri diturunkan deterministik, clawback proporsional saat refund. **Izin laporan:** `ReportScope.clamp()` di server.

## Asumsi paling berisiko
1. Protokol push terminal absensi (ZKTeco-kompatibel) dan model perangkat nyata **[V09]** — tanpa perangkat, hanya simulator yang terbukti.
2. Penyimpanan PWA di iPad bertahan **[V01][V02]** — spike di M4, Capacitor+SQLite di P2.
3. Cakupan sangat luas untuk satu orang; P1 harus berdiri sendiri dan pemotongan sudah diurutkan.
4. Pasar: permintaan untuk retail/POS custom di Upwork belum diverifikasi; demo berbahasa Inggris.
5. Semua klaim perangkat keras/pihak ketiga (V01–V21) berlabel di TECH-SPEC §10 dan belum diuji.

## Kemandirian
Keputusan 2026-11-04: Shelfline ditulis dari nol; tidak ada kode, paket, atau data yang dibagikan dengan Weft atau proyek lain. Pola umum (outbox, ledger idempoten) dirancang ulang di TECH-SPEC.

## Desain
Sistem sendiri "shelf-edge": terang (adegan toko), grafit + aksen volt kuning-hijau, Archivo + Azeret Mono, **lembar dot-leader** untuk ringkasan uang, **rail lokasi dengan status langsung** sebagai navigasi. Lihat [DESIGN.md](DESIGN.md) dan [mockups/index.html](mockups/index.html) (POS Sell offline, Registers & sessions, Inventory + stock card, Components). Detektor Impeccable bersih; screenshot 1440/1180/390 di `.impeccable/review/`.

## Dokumen
- [PRODUCT.md](PRODUCT.md) · [DESIGN.md](DESIGN.md)
- [docs/PRD.md](docs/PRD.md) · [docs/TECH-SPEC.md](docs/TECH-SPEC.md) · [docs/MILESTONES.md](docs/MILESTONES.md)
- [docs/FEATURE-MAP.md](docs/FEATURE-MAP.md) · [docs/IA.md](docs/IA.md) · [docs/SCREENS.md](docs/SCREENS.md)
- [mockups/index.html](mockups/index.html)
