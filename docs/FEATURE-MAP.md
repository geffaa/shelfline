# Feature Map — Shelfline

Fase berdasarkan urutan ketergantungan, bukan waktu. P1 harus berdiri sendiri sebagai sistem jual yang benar (jual, uang, stok). P2 menambah operasi toko di atas P1. P3 menambah pertumbuhan dan skala di atas P2. Tidak ada estimasi waktu atau biaya (proyek sendiri).

Klaim yang bergantung pada perangkat keras atau layanan pihak ketiga ditandai **[V##]** dan didaftar di TECH-SPEC §10.

## 1. Riset pesaing (ringkas, bersumber)

Sumber riset 2026-11-04 lewat pencarian web; halaman pesaing berubah dan tier fitur berbeda per wilayah **[V13]**.

| Kemampuan | Lightspeed Retail (X-Series) | Shopify POS | Yang Shelfline ambil / bedakan |
|---|---|---|---|
| Tutup register | Hitung per pecahan uang, total otomatis; data tutup mengalir ke Xero ([Lightspeed support](https://x-series-support.lightspeedhq.com/hc/en-us/articles/40487862691611-August-product-updates-roundup), [Xero](https://www.xero.com/vend/)) | Melacak saldo laci untuk setoran akhir hari ([Shopify](https://shopify.com/features)) | Hitung per pecahan **dan** buta (blind count) opsional; selisih masuk buku besar kas, bukan angka tunggal |
| Pergerakan kas | Kas masuk/keluar, petty cash, float buka/tutup tersinkron ke akuntansi ([Xero](https://www.xero.com/vend/)) | Pelacakan kas dasar | Cash movement bertipe (pay-in, pay-out, drop, float) + **laci dibuka tanpa penjualan** sebagai peristiwa kelas satu yang bisa memicu notifikasi |
| Purchase order | PO, email ke pemasok, tindak lanjut item belum diterima dari halaman Stock control ([Lightspeed](https://x-series-support.lightspeedhq.com/hc/en-us/articles/53815729984155-July-product-updates-roundup)) | PO dibuat di admin Shopify; sebagian wilayah menyebutnya fitur Pro ([Shopify AE](https://www.shopify.com/ae/pos/features), [Shopify IN](https://www.shopify.in/pos/software)) | PO sampai penerimaan parsial, biaya mendarat, tagihan pemasok (keuangan vendor) dalam satu alur |
| Transfer stok | Outlet penerima menyetujui/menolak; penjualan dapat dipenuhi dari lokasi lain bila diaktifkan ([Lightspeed](https://x-series-support.lightspeedhq.com/hc/en-us/articles/53815729984155-July-product-updates-roundup)) | Transfer keluar/masuk di POS 10.20, izin per staf ([Shopify changelog](https://changelog.shopify.com/posts/fulfilling-transfers-with-shopify-pos)) | Transfer dua kaki lewat lokasi "dalam perjalanan" sehingga stok tidak hilang di tengah jalan |
| Price book | Berlaku untuk toko, online, atau keduanya ([Lightspeed](https://x-series-support.lightspeedhq.com/hc/en-us/articles/53815729984155-July-product-updates-roundup)) | Katalog per pasar | Price book berlaku-tanggal, per lokasi/grup, dengan dasar harga yang tercatat di baris penjualan |
| Gift card | Dijual dan ditebus di toko; liabilitas diposting dengan penutupan register ([Xero](https://www.xero.com/vend/)) | Ada | Saldo = buku besar entri; penebusan offline dibatasi kebijakan (lihat TECH-SPEC §5.4) |
| Komisi | Tidak jadi fokus (perlu verifikasi) | Atribusi penjualan ke staf; pelacakan komisi tercantum fitur Pro ([Shopify PH](https://www.shopify.com/ph/pos/features.html), [ru](https://ru.shopify.com/pos/software)) | **Komisi per kasir dengan aturan berversi dan alokasi otomatis** (pembagian, pool jam kerja, clawback saat refund) |
| Izin laporan | Peran umum | Peran khusus fitur Pro ([ru.shopify.com](https://ru.shopify.com/pos/software)) | Izin laporan **per pengguna × lokasi × rentang waktu × kolom**, diterapkan di server, plus portal terbatas |
| Absensi | Tidak ada bawaan (perlu verifikasi) | Tidak ada bawaan | Absen sidik jari terminal jaringan yang tersambung ke status POS **[V09]** |

Pesaing lokal/regional (KiotViet, Moka, Majoo, Olsera) tidak diriset di sini; belum ada bukti permintaan dari lowongan acuan. Dicatat sebagai celah riset.

## 2. Peta fitur per fase

Kode fitur dipakai di PRD, SCREENS, dan MILESTONES.

### P1 — Inti penjualan (sistem jual yang benar)

| ID | Fitur | Bergantung pada |
|---|---|---|
| F1 | Organisasi, lokasi, register, zona waktu per lokasi | — |
| F2 | Pengguna, peran, izin, PIN kasir, 2FA admin, audit log | F1 |
| F3 | Katalog: produk, varian, barcode, kategori, pajak, harga dasar | F1 |
| F4 | Buku besar stok per lokasi: saldo, kartu stok, penerimaan & penyesuaian manual | F1, F3 |
| F5 | Mesin sinkron dan penyimpanan lokal (perintah idempoten, kursor tarik) | F2, F3, F4 |
| F6 | POS jual: scan/cari, keranjang, diskon berizin, parkir penjualan, lampirkan pelanggan | F5 |
| F7 | Pembayaran dan struk: tunai, kartu (manual/ditandai), split, kembalian, struk digital | F6 |
| F8 | Sesi register: buka dengan float, cash movement, no-sale, tutup dengan hitung dan selisih, laporan Z | F7 |
| F9 | Retur dan refund terhadap penjualan asli, batas refund, alasan | F7, F8 |
| F10 | Pesanan dan pelanggan (daftar, detail, profil, catatan) | F7 |
| F11 | Admin: Hari Ini, Register, laporan dasar (penjualan, Z) | F8, F10 |
| F12 | Mode offline dan pemulihan: antrean, status sinkron, konflik terlihat | F5 |
| F13 | Peristiwa clock in/out dasar lewat PIN di POS | F2, F5 |

### P2 — Operasi toko

| ID | Fitur | Bergantung pada |
|---|---|---|
| F14 | Pemasok, purchase order, penerimaan parsial, biaya mendarat | F4 |
| F15 | Keuangan vendor: tagihan, pembayaran, aging, cocokkan tagihan dengan penerimaan | F14 |
| F16 | Transfer stok antar lokasi (dua kaki, dalam perjalanan, selisih) | F4, F14 |
| F17 | Stock count (penuh/siklus, buta, sesuaikan sebagai delta) | F4 |
| F18 | Price book dan promosi berlaku-tanggal | F3, F6 |
| F19 | Gift card dan store credit (buku besar saldo) | F7, F10 |
| F20 | Jadwal shift (papan roster, templat, kebutuhan per lokasi) | F2 |
| F21 | Timesheet: dari punch ke jam kerja, persetujuan, koreksi tercatat | F13, F20 |
| F22 | Absen sidik jari: terminal jaringan, jembatan perangkat, status terhubung ke POS | F13, F21 |
| F23 | Komisi per kasir: aturan berversi, alokasi otomatis, clawback, laporan & penutupan periode | F7, F9, F21 |
| F24 | Izin laporan per pengguna/lokasi/rentang waktu/kolom dan portal laporan terbatas | F11 |
| F25 | Notifikasi: clock in/out, register buka/tutup, laci dibuka tanpa penjualan, selisih kas, refund besar | F8, F13, F22 |
| F26 | Laporan akhir hari otomatis: penerima, jam, metode dapat diatur; versi sementara dan koreksi | F11, F24, F25 |
| F27 | Perangkat POS: printer struk, laci kas, pemindai Bluetooth, pembungkus Capacitor | F7 |
| F28 | Pembayaran kartu terintegrasi (terminal pembaca) | F7, F27 |

### P3 — Pertumbuhan dan skala

| ID | Fitur | Bergantung pada |
|---|---|---|
| F29 | Toko online (storefront Next.js), ketersediaan per lokasi, ambil di toko | F3, F4, F18 |
| F30 | Channel Shopify dua arah (katalog, stok, pesanan) | F4, F10 |
| F31 | Marketing automation: segmen, kampanye, alur (win-back, ulang tahun, pascabeli) | F10, F29 |
| F32 | Loyalti (poin, tingkat) | F10, F31 |
| F33 | Ekspor akuntansi (Xero) dari penutupan hari/periode | F8, F15, F19 |
| F34 | Saran replenishment dan pemesanan ulang otomatis menjadi draf PO | F14, F16 |
| F35 | Pengerasan: RLS Postgres per organisasi, SSO, adaptor terminal absensi kedua, multi-organisasi | semua |

## 3. Sengaja tidak dikerjakan
Payroll dan penggajian (hanya timesheet dan komisi sebagai angka masukan; aturan upah/award di luar lingkup **[V18]**); pengelolaan resep/produksi; marketplace multi-vendor; POS restoran (meja, dapur); implementasi biometrik sendiri (template sidik jari tidak pernah disimpan di Shelfline).
