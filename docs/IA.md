# Information Architecture — Shelfline (bentuk fase akhir)

Navigasi diputuskan dari bentuk akhir produk (P1+P2+P3), lalu P1 hanya menampilkan sebagian.

## 1. Permukaan produk

| Permukaan | Perangkat | Pengguna | Aplikasi |
|---|---|---|---|
| **POS** | iPad (landscape utama; layar sempit sebagai mode genggam untuk cek stok/terima transfer) | Kasir, store manager | `apps/pos` (PWA offline-first; P2 dibungkus Capacitor) |
| **Back-office admin** | Laptop/desktop; tablet bisa | Owner, HQ manager, store manager, purchaser, finance, HR/roster | `apps/admin` |
| **Portal laporan terbatas** | Browser apa pun, termasuk ponsel | Akuntan eksternal, area manager, mitra yang diberi izin | `apps/portal` |
| **Jembatan perangkat** | Mini-PC/Raspberry Pi/Mac mini di jaringan toko; UI status lokal | Teknisi toko / manager | `apps/bridge` (daemon + halaman status lokal) |
| Toko online (P3) | Browser | Pelanggan | `apps/storefront` |

## 2. Peran

| Peran | Cakupan data | Hal khas |
|---|---|---|
| Owner | Semua lokasi | Izin laporan, peran, perangkat, penutupan periode komisi |
| HQ manager | Semua lokasi (dapat dibatasi) | Katalog, price book, PO, transfer, jadwal |
| Store manager | Lokasi yang ditugaskan | Hitung/setuju selisih kas, setujui timesheet, override di POS |
| Purchaser | Semua/sebagian lokasi | Pemasok, PO, penerimaan, tagihan vendor |
| Finance | Semua lokasi, hanya baca transaksi + tulis keuangan vendor | Laporan, ekspor akuntansi, tagihan |
| Roster/HR | Lokasi yang ditugaskan | Jadwal, timesheet, enrol terminal absensi |
| Kasir (cashier) | Satu lokasi, register aktif | PIN, jual, refund terbatas, cash movement terbatas |
| Pembaca portal | Sesuai `report_grant` | Hanya laporan yang diizinkan, lokasi dan rentang waktu yang diizinkan |
| Teknisi perangkat | Perangkat satu lokasi | Pairing jembatan, terminal, printer |
| Pelanggan (P3) | Dirinya | Akun toko online, pesanan |

## 3. Navigasi admin: keputusan dan trade-off

**Keputusan: lokasi sebagai navigator utama (rail lokasi di kiri), domain sebagai bar atas.**

- **Rail lokasi (kiri, ±232px):** "Semua lokasi" lalu daftar lokasi dengan titik status langsung (buka/tutup, jumlah register aktif, jumlah perangkat offline). Memilih lokasi memberi "lensa" yang membatasi setiap layar. Gudang/DC adalah lokasi bertipe berbeda di daftar yang sama.
- **Bar domain (atas):** Today · Sell · Stock · People · Money · Grow, ditambah Admin (ikon roda gigi). Di bawahnya strip halaman untuk domain terpilih.
- Di ponsel: rail lokasi menjadi sheet pemilih lokasi di header; bar domain menjadi tab bawah enam item.

**Mengapa:** pertanyaan operator retail adalah "toko mana, apa yang terjadi" lebih sering daripada "modul apa". Izin juga berbasis lokasi (store manager hanya satu lokasi, laporan diberi izin per lokasi), jadi lensa lokasi persisten membuat batas izin terlihat di UI.

**Alternatif ditolak:**
- Sidebar modul 9–12 grup (seperti Shopify/Lightspeed): terbukti, tapi lokasi tersembunyi di filter per halaman sehingga mudah salah konteks (menyesuaikan stok di lokasi yang salah). Konteks lokasi per halaman memang rawan kesalahan tindakan tulis.
- Navigasi atas saja: 6 domain × 4–8 halaman tidak muat tanpa mega-menu.

**Risiko:** rail lokasi memakan lebar; dengan 40+ lokasi daftar perlu pencarian dan pengelompokan wilayah (dirancang: pencarian ketik + grup; layar S43 menjadikannya per wilayah). Halaman yang tidak mengenal lokasi (Katalog, Pemasok, Peran) menampilkan rail dalam keadaan "Semua" dan tidak bisa dipersempit; tombol tulis lokasi-spesifik menyebut lokasinya di label ("Adjust stock at Fitzroy").

## 4. Peta modul per domain (fase akhir)

| Domain | Halaman | Layar | Fase |
|---|---|---|---|
| **Today** | Overview lokasi (penjualan langsung, register, kas, perangkat, antrean sinkron, peringatan) | S20 | P1 |
| | Registers & sessions (daftar sesi, detail sesi, laporan Z) | S21 | P1 |
| | Alerts & notifikasi (log + aturan) | S41 | P2 |
| **Sell** | Orders (daftar, detail, refund) | S22 | P1 |
| | Customers (profil, kredit, gift card) | S23 | P1 (kredit P2) |
| | Gift cards & store credit | S31 | P2 |
| | Online store (kanal, ketersediaan, ambil di toko) | S45 | P3 |
| **Stock** | Products (daftar, editor varian) | S24 | P1 |
| | Price books | S25 | P2 |
| | Inventory (level per lokasi, kartu stok) | S26 | P1 |
| | Purchase orders | S27 | P2 |
| | Transfers | S29 | P2 |
| | Stock counts | S30 | P2 |
| **People** | Staff & roles | S42 | P1 |
| | Schedule | S33 | P2 |
| | Timesheets | S34 | P2 |
| | Attendance terminals | S35 | P2 |
| | Commission (aturan + pernyataan) | S36, S37 | P2 |
| **Money** | Suppliers & bills (keuangan vendor) | S28, S32 | P2 |
| | Reports (pustaka + penampil) | S38 | P1 dasar, P2 penuh |
| | Report access (izin) | S39 | P2 |
| | End-of-day schedules | S40 | P2 |
| | Accounting export | S47 | P3 |
| **Grow** | Marketing (segmen, kampanye, alur) | S46 | P3 |
| | Loyalty | S46 | P3 |
| **Admin** | Locations & registers, pajak, struk, metode bayar | S43 | P1 |
| | Audit log | S44 | P1 |
| | Integrations | S47 | P2–P3 |
| | Sign-in & 2FA | S48 | P1 |

## 5. POS: alur layar

POS tidak memakai navigasi domain. Satu **bilah kiri tipis** berisi: Sell, Orders (lookup/refund), Cash, Stock (genggam), Shift (clock/sesi), dan indikator Sync di dasar. Layar Sell adalah layar default.

```
S01 Sign in (PIN) → S02 Open register (float) → S03 Sell ⇄ S06 Customer
                                         S03 → S04 Payment → S05 Receipt → S03
                                         S03 → park → S07 Recall
Dari bilah: S07 Orders lookup/refund · S08 Cash movement · S12 Stock on the floor
            S10 Shift (clock in/out, sesi) · S11 Sync status
S08/S10 → S09 Close register (hitung → selisih → laporan Z)
```

## 6. Jembatan perangkat: alur layar

`S71 Pairing` (kode dari admin S35 dimasukkan ke bridge) → `S70 Status` (terminal absensi terhubung, printer terdeteksi, antrean keluar, log). Tidak ada login biasa; bridge diautentikasi dengan kunci perangkat hasil pairing.

## 7. Portal laporan terbatas: alur layar

`S60 Sign in (kode email)` → `S61 My reports` (hanya laporan yang diizinkan) → `S62 Report viewer` (spanduk lingkup selalu terlihat: lokasi dan rentang waktu yang diizinkan; tanggal di luar izin tidak bisa dipilih). Izin berakhir → layar "Access ended" yang menyebut siapa pemberi izin.

## 8. Alur end-to-end

**A. Barang masuk sampai terjual sampai dibayar ke pemasok** (P1+P2)
1. Purchaser membuat PO ke pemasok (S27) → disetujui → dikirim email.
2. Barang tiba di DC: penerimaan parsial (S27) → buku besar stok menambah `receive_po`, biaya mendarat memperbarui rata-rata bergerak (S26).
3. Transfer ke toko (S29): kaki keluar di DC, barang "dalam perjalanan", penerimaan di toko dengan selisih tercatat.
4. Kasir menjual (S03→S04→S05); stok toko berkurang lewat sinkron.
5. Tagihan pemasok dicocokkan dengan penerimaan (S32); pembayaran dicatat; aging diperbarui.

**B. Shift kasir hari itu** (P1+P2)
1. Kasir menempelkan jari di terminal absensi (S35 menerima punch via bridge S70) → status "clocked in" di POS (S10); tanpa punch, POS meminta pembenaran manajer.
2. Kasir masuk dengan PIN (S01), membuka register dengan hitung float (S02) → notifikasi "register dibuka" (S41).
3. Penjualan, retur, cash movement, no-sale (S03–S09). Laci dibuka tanpa penjualan memicu notifikasi.
4. Tutup register: hitung per pecahan, selisih, laporan Z (S09, S21).
5. Clock out; timesheet terbentuk (S34); komisi hari itu teralokasi (S37).
6. Laporan akhir hari terkirim sesuai jadwal ke penerima (S40); portal menampilkannya untuk akuntan (S61–S62).

**C. Penjualan offline** (P1)
Jaringan putus saat S04 → penjualan tetap selesai, struk dengan nomor register-lokal → antrean S11 → jaringan kembali → sinkron → server menerima, menandai anomali (stok negatif, harga beda) sebagai pengecualian di S20/S22.

**D. Refund** (P1+P2)
Pencarian penjualan (S07/S22) → pilih baris → kebijakan refund (batas, izin, alasan) → pengembalian ke tunai/kartu/store credit (P2) → stok masuk lagi (opsional rusak) → komisi di-clawback otomatis (S37).

**E. Rekrut sampai berhenti (karyawan toko)** (P1–P2)
Buat pengguna + PIN (S42) → enrol sidik jari di terminal (fisik, bukan di Shelfline; S35 mencatat status) → masuk jadwal (S33) → bekerja → ubah peran/lokasi → nonaktifkan: PIN dicabut seketika, enrol dihapus dari terminal lewat perintah bridge, riwayat tetap utuh untuk audit.

**F. Izin laporan untuk akuntan** (P2)
Owner membuat grant (S39): pengguna, jenis laporan, lokasi, rentang waktu (tetap atau bergulir), kolom disembunyikan (mis. biaya/margin) → akuntan menerima undangan → S60→S62. Setiap tampilan tercatat di audit.

**G. Pelanggan online ambil di toko** (P3)
Storefront (S80–S82) memeriksa ketersediaan lokasi → pesanan masuk sebagai order kanal online → stok dicadangkan di lokasi → POS S22/S07 menyiapkan → pelanggan ambil → penjualan selesai di POS.
