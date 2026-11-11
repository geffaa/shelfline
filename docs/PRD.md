# PRD — Shelfline

Status: draft · Tanggal: 2026-11-04 · Sumber: Project #8 portfolio-roadmap; lowongan Upwork yang meminta gabungan Shopify dan Lightspeed (POS iPad, inventori multi-lokasi, absen sidik jari terintegrasi POS, komisi, izin laporan, laporan akhir hari).

## 1. Ringkasan
Shelfline adalah platform manajemen retail dan POS multi-lokasi: POS iPad yang tetap menjual saat jaringan putus, back-office untuk produk, stok per lokasi, pembelian, transfer, orang dan jam kerja, komisi, dan uang, portal laporan terbatas untuk pihak luar, dan jembatan perangkat yang menghubungkan terminal absensi sidik jari dan printer struk di toko. Satu buku besar stok dan satu buku besar kas menjadi dasar semua angka. Demo memakai retail fiktif "Kestrel Run Co." (sepatu lari, 4 toko + 1 gudang).

## 2. Masalah
Pemilik retail kecil-menengah dengan 3–20 toko biasanya merangkai Shopify/Lightspeed untuk jual-stok, aplikasi absensi terpisah, spreadsheet untuk komisi, dan email manual untuk laporan akhir hari. Akibatnya: (1) tidak ada satu tempat untuk melihat "kas, stok, dan siapa yang bekerja" di satu toko; (2) komisi dihitung manual sehingga sengketa; (3) akuntan atau area manager hanya bisa diberi akses penuh atau tidak sama sekali; (4) POS berbasis browser gagal saat Wi-Fi toko putus. Pesaing: Lightspeed Retail X-Series dan Shopify POS mencakup register, PO, transfer, price book, gift card ([sumber di FEATURE-MAP](FEATURE-MAP.md)), tetapi absensi sidik jari, komisi per kasir, dan izin laporan per lokasi/rentang tidak menjadi inti **[V13]**.

## 3. Tujuan & metrik sukses
- Tujuan: (a) POS yang benar saat offline, (b) stok dan kas yang bisa ditelusuri sampai peristiwa, (c) menutup celah operasional yang disebut lowongan (absen, komisi, izin laporan, laporan otomatis), (d) tiga permukaan plus jembatan dengan layar dan alur lengkap.
- Metrik portfolio: bukti teknis (suite sinkron 10 klien acak lulus; ledger konsisten setelah 100% pemutaran ulang; matriks izin laporan nol kebocoran; demo berjalan), sinyal pasar (balasan/undangan dari proposal yang menautkan demo).
- Non-goal: payroll, POS restoran, marketplace, menyimpan biometrik, bersaing fitur-demi-fitur dengan Lightspeed.

## 4. Persona & konteks
| Peran | Situasi | Pekerjaan | Frustrasi |
|---|---|---|---|
| Kasir (Priya, Fitzroy) | iPad di meja kasir, ramai akhir pekan | Jual cepat, hitung kas, clock in/out | Wi-Fi putus, antrean tak terlihat, selisih kas disalahkan |
| Store manager (Marcus) | Laptop di kantor belakang + iPad di lantai | Tinjau sesi, setujui selisih, jadwal, timesheet | Tidak tahu siapa menekan "no sale"; laporan harian manual |
| Purchaser/HQ (Dana) | Laptop | PO, penerimaan, transfer antar toko | Stok tak jelas di perjalanan; selisih penerimaan |
| Owner (Elena) | Ponsel + laptop | Kinerja toko, komisi, siapa boleh lihat apa | Sengketa komisi; akuntan minta akses terlalu besar |
| Akuntan eksternal | Browser ponsel/laptop | Ambil laporan akhir bulan | Mendapat akses penuh atau kirim ulang spreadsheet |
| Teknisi toko | Mini-PC di ruang belakang | Pasang terminal & printer | Konfigurasi perangkat tersebar |

## 5. Asumsi
| # | Asumsi | Risiko jika salah |
|---|---|---|
| A1 | Pasar yang dituju: lowongan Upwork seperti acuan (retail multi-lokasi, kemungkinan AU/UK/US); demo berbahasa Inggris, AUD | Sedang |
| A2 | Stok negatif diizinkan pada penjualan fisik; flagged, bukan ditolak | Rendah |
| A3 | Terminal absensi mengirim catatan kehadiran lewat protokol push yang bisa ditangkap bridge **[V09]** | **Tinggi** (tanpa perangkat nyata tak terbukti; simulator dipakai) |
| A4 | PWA terpasang di iPad cukup andal untuk P1; Capacitor+SQLite di P2 bila penyimpanan dievik **[V01][V02]** | **Tinggi** |
| A5 | Pembayaran kartu P1 hanya dicatat (tender ditandai); integrasi terminal P2 **[V11]** | Sedang |
| A6 | Redeem gift card offline dimatikan secara default | Rendah |
| A7 | Satu organisasi per deployment; `org_id` disiapkan | Rendah |
| A8 | Tidak ada payroll; timesheet dan komisi sebagai keluaran angka | Rendah |
| A9 | Satu mata uang per organisasi (AUD) | Rendah |
| A10 | Biometrik hanya di terminal; aspek hukum diverifikasi sebelum klaim publik **[V10]** | Sedang |
| A11 | Pengguna tidak membutuhkan pembayaran kartu offline | Rendah |
| A12 | Bahasa UI Inggris; dokumen Indonesia | Rendah |

## 6. Scope
- **MVP (P1):** F1–F13.
- **Nanti:** P2 F14–F28 (operasi toko); P3 F29–F35 (pertumbuhan dan skala). Daftar dan urutan ketergantungan di [FEATURE-MAP](FEATURE-MAP.md).
- **Bukan tujuan:** lihat FEATURE-MAP §3.

"MVP" di sini = fase P1: sistem jual yang berdiri sendiri dan benar. Ukurannya besar untuk satu orang; urutan pemotongan di MILESTONES (F12/F13 dan laporan dasar dipertahankan, kustomisasi struk dipotong lebih dulu).

## 7. User stories (ringkas)
- F1/F2: Sebagai owner, saya ingin mendaftarkan lokasi dan mengatur siapa boleh melakukan apa di lokasi mana, supaya store manager hanya melihat tokonya.
- F3: Sebagai HQ manager, saya ingin varian dengan barcode dan pajak, supaya kasir menjual dengan scan.
- F4: Sebagai purchaser, saya ingin kartu stok per lokasi, supaya setiap angka bisa ditelusuri.
- F6–F7: Sebagai kasir, saya ingin menjual dan menerima tunai/kartu/split, supaya pelanggan cepat dilayani.
- F8: Sebagai store manager, saya ingin sesi register dengan float, cash movement, dan hitung tutup, supaya selisih kas jelas penyebabnya.
- F9: Sebagai kasir, saya ingin refund terhadap penjualan asli, supaya stok dan kas konsisten.
- F12: Sebagai kasir, saya ingin tetap menjual saat internet putus dan melihat antrean, supaya tidak ada transaksi hilang.
- F13: Sebagai kasir, saya ingin mencatat masuk/pulang kerja.
- (P2) F22/F23/F24/F26 mengikuti tabel di §8b.

## 8. Fitur P1 secara detail

Layar merujuk SCREENS.

**F1 Organisasi, lokasi, register** · S43
- Buat lokasi bertipe store/warehouse dengan zona waktu dan batas hari bisnis; tambah register dengan kode unik.
- Ketika lokasi dibuat tanpa zona waktu, maka sistem menolak dan menyebut field.
- Ketika kode register sudah dipakai, maka sistem menolak.
- Ketika batas hari bisnis 04:00 dan penjualan terjadi 02:30 waktu lokal, maka `local_date` = hari sebelumnya.
- Edge: lokasi dengan sesi terbuka tidak bisa dinonaktifkan.

**F2 Pengguna, peran, izin, PIN, audit** · S42, S44, S48, S01
- Peran × lokasi; PIN Argon2id; 2FA admin.
- Ketika peran pengguna diubah, maka request berikutnya memakai peran baru tanpa login ulang.
- Ketika PIN salah N kali, maka akun terkunci di POS dan manajer yang membuka.
- Ketika store manager Fitzroy meminta data South Yarra, maka 403 dan tercatat.
- Ketika seseorang mengubah harga/diskon di atas batas/stok, maka baris audit berisi sebelum-sesudah.

**F3 Katalog** · S24
- Produk → varian (opsi, SKU, barcode), kategori, kelas pajak, harga dasar.
- Ketika SKU kembar (tanpa beda huruf besar/kecil, spasi dipangkas), maka ditolak dengan menyebut varian yang sudah ada.
- Ketika barcode dipindai di POS, maka varian ditemukan < 100 ms dari replika lokal.
- Edge: impor CSV 5.000 baris dengan 12 kesalahan → laporan per baris, baris valid tetap masuk.

**F4 Buku besar stok** · S26
- Penerimaan manual, penyesuaian dengan alasan, saldo per varian per lokasi, kartu stok.
- Ketika penjualan yang sama diproses dua kali, maka stok turun sekali.
- Ketika `SUM(qty_delta)` ≠ `on_hand`, maka alarm di Today.
- Ketika dua penyesuaian bersamaan, maka keduanya tercatat dan saldo = jumlah keduanya.
- Edge: adjust ke lokasi yang tidak ada izin → ditolak.

**F5 Mesin sinkron** · S11
- Tarik replika; dorong perintah idempoten.
- Ketika perintah dikirim tiga kali, maka satu efek.
- Ketika klien putus di tengah batch, maka kelanjutan tidak menggandakan.
- Ketika versi skema aplikasi terlalu lama, maka antrean dikosongkan lalu "Update required".
- Edge: jam perangkat melenceng > 5 menit → `skewed_clock`.

**F6 POS Jual** · S03, S06
- Scan/cari, qty, diskon berizin, parkir, lampirkan pelanggan.
- Ketika barcode tak dikenal, maka pesan jelas dan opsi cari manual.
- Ketika diskon melebihi batas kasir, maka PIN manajer diminta.
- Ketika penjualan diparkir lalu aplikasi di-refresh, maka tetap ada.
- Edge: 30 baris keranjang tetap responsif.

**F7 Pembayaran dan struk** · S04, S05
- Tunai (kembalian), kartu (catatan ditandai P1), split, struk digital (tautan/email) dan tampilan struk.
- Ketika tunai kurang dari total tanpa tender lain, maka tombol Selesai nonaktif.
- Ketika split tunai + kartu, maka total tender = total.
- Ketika pajak inklusif, maka struk menunjukkan GST yang sama dengan hitungan server.
- Edge: pembulatan tunai per lokasi (opsional).

**F8 Sesi register** · S02, S08, S09, S21
- Buka dengan float, pay-in/out/drop, no-sale, tutup dengan hitung, selisih, laporan Z.
- Ketika register dibuka saat sesi lain terbuka, maka ditolak atau paksa tutup dengan flag.
- Ketika hitung tutup berbeda dari ekspektasi, maka selisih tercatat dan melebihi ambang minta PIN manajer.
- Ketika no-sale dilakukan, maka peristiwa bertanda waktu dan alasan wajib (kecuali peran yang dikecualikan).
- Edge: tutup saat ada perintah belum sinkron → tutup sementara, final setelah sinkron.

**F9 Retur dan refund** · S07, S22
- Ketika refund diminta untuk qty melebihi yang dijual dikurangi yang sudah direfund, maka ditolak online; offline diterima dengan `over_refund`.
- Ketika barang dikembalikan masuk stok, maka `refund_return` bertambah di lokasi yang menerima (bisa berbeda dari penjualan).
- Edge: refund tanpa struk asli → izin manajer.

**F10 Pesanan dan pelanggan** · S22, S23, S06
- Daftar, detail dengan garis waktu, profil.
- Ketika dua pelanggan berbagi email, maka satu menjadi kandidat gabung.
- Edge: pelanggan tanpa persetujuan marketing tidak muncul di segmen (P3).

**F11 Admin Hari Ini, Register, laporan dasar** · S20, S21, S38
- Ketika penjualan tersinkron, maka papan Hari Ini diperbarui lewat SSE.
- Ketika admin memilih lokasi di rail, maka seluruh angka dibatasi lokasi itu.
- Edge: lokasi tutup menampilkan ringkasan kemarin.

**F12 Offline dan pemulihan** · S11
- Ketika jaringan putus, maka spanduk offline muncul dan penjualan lanjut.
- Ketika jaringan kembali, maka antrean terkirim berurutan dan hasil per perintah tampil.
- Ketika penyimpanan lokal terancam (persist ditolak), maka peringatan tetap.
- Edge: ekspor JSON antrean untuk pemulihan darurat.

**F13 Clock in/out dasar** · S10
- Ketika kasir clock in dengan PIN, maka `punch` metode `pin` dengan flag `needs_review` bila jadwal ada (P2).
- Edge: dua clock in berturut-turut → yang kedua ditandai.

## 8b. Fitur P2/P3: kriteria penerimaan kunci

| Fitur | Kriteria |
|---|---|
| F14 PO | Ketika penerimaan parsial 40 dari 60, maka stok bertambah 40, PO `partial`, sisa terbuka. |
| F15 Keuangan vendor | Ketika tagihan 60 unit dicocokkan dengan penerimaan 40, maka selisih 20 ditandai dan pembayaran tertahan. |
| F16 Transfer | Ketika transfer 12 dikirim lalu diterima 11, maka transit nol, 1 `transfer_variance`, jumlah total semua lokasi konsisten. |
| F17 Stock count | Ketika hitung dikomit setelah 3 penjualan sejak snapshot, maka penyesuaian = hitung − ekspektasi snapshot dan penjualan tidak tertimpa. |
| F18 Price book | Ketika dua price book berlaku, maka prioritas tertinggi dipakai dan baris penjualan menyimpan `price_book_id`. |
| F19 Gift card | Ketika kartu saldo 50 ditebus 30 di dua perangkat berbeda secara bersamaan, maka total tak melampaui plafon kebijakan dan overdraft ditandai. |
| F20/F21 Jadwal & timesheet | Ketika punch masuk 09:12 untuk shift 09:00, maka entri menunjukkan terlambat 12 menit; koreksi manajer menambah entri, bukan menimpa. |
| F22 Absen sidik jari | Ketika terminal mengirim catatan kehadiran untuk kode 117, maka `punch` terbentuk sekali (kirim ulang tidak menggandakan) dan status POS berubah dalam interval tarik berikutnya. Kode tak dikenal → `needs_review`. |
| F23 Komisi | Ketika penjualan A$219.95 dengan tarif 4% net ex-GST, maka entri = 4% × (219.95/1.1) dibulatkan; refund penuh menolkannya. |
| F24 Izin laporan | Ketika grant Fitzroy 1–31 Okt, maka tidak ada jalur (UI/CSV/URL) yang menampilkan lokasi lain, tanggal di luar rentang, atau kolom biaya. |
| F25 Notifikasi | Ketika no-sale terjadi, maka penerima aturan menerima pesan < 1 menit setelah sinkron; jam tenang menahan non-kritis. |
| F26 EOD | Ketika jadwal 21:30 waktu Perth, maka laporan terkirim pada 21:30 Perth (tanpa DST), dan jika perangkat belum sinkron, versi `provisional` lalu `amended` hanya bila angka berubah. |
| F27 Perangkat | Ketika Pay selesai tunai, maka struk tercetak dan laci terbuka lewat bridge/printer. |
| F28 Kartu | Ketika terminal menolak, maka tidak ada penjualan selesai dengan tender kartu. |
| F29 Toko online | Ketika stok lokasi 0, maka tombol ambil di toko lokasi itu nonaktif. |
| F30 Shopify | Ketika webhook yang sama dikirim 3×, maka satu pesanan dan satu pengurangan stok. |
| F31 Marketing | Ketika pelanggan tidak memberi persetujuan, maka tidak masuk kampanye apa pun. |
| F33 Ekspor | Ketika periode ditutup, maka ekspor jurnal seimbang (debit = kredit). |

## 9. User flow
Alur utama (kasir, P1): S01 Sign in → S02 Open register → S03 Sell (S06 pelanggan opsional) → S04 Payment → S05 Receipt → (S07 refund bila perlu; S08 cash movement; S11 bila offline) → S09 Close register → S21 (manager meninjau). Admin: S48 Sign in → S20 Today → S21/S22 → S24 → S26. Alur lengkap A–G lintas fase ada di [IA](IA.md) §8.

## 10. Kebutuhan non-fungsional
- Keamanan & privasi: PIN Argon2id, token per audiens, audit tak berubah, biometrik tidak disimpan **[V10]**.
- Performa: scan→baris keranjang < 100 ms dari replika; penjualan selesai tanpa menunggu jaringan; Today diperbarui < 2 dtk setelah sinkron.
- Aksesibilitas: WCAG 2.2 AA; target sentuh POS ≥ 48 px; kontrol form kustom dengan ARIA.
- Lokalisasi: waktu per lokasi, hari bisnis, mata uang AUD, GST **[V15]**; UI Inggris.
- Keandalan: idempotensi di setiap batas; outbox; backup harian; pemutaran ulang menghasilkan keadaan sama.

## 11. Risiko & pertanyaan terbuka
| Risiko | Uji termurah |
|---|---|
| Penyimpanan Safari dievik **[V01][V02]** | Spike PWA di iPad nyata di M4 |
| Protokol terminal absensi berbeda **[V09]** | Simulator dulu; satu terminal nyata sebelum klaim |
| Kompleksitas sinkron | Tes 10 klien acak sebelum POS dibangun |
| Cakupan sangat luas | Fase P1 berdiri sendiri; pemotongan di MILESTONES |
Pertanyaan terbuka: perangkat keras apa yang tersedia untuk uji (terminal absensi, printer, laci) — diputuskan sebelum M14 (P2).

## 12. Distribusi & monetisasi
Portfolio: repo GitHub + demo sintetis + studi kasus + video 2 menit; kata kunci Upwork: "multi-location POS", "offline-first", "Shopify and Lightspeed alternative", "inventory ledger", "biometric attendance integration". Dipakai di proposal untuk lowongan retail/POS/inventori. Tidak ada rencana monetisasi produk.
