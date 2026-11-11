# Screens — Shelfline

Mode Impeccable: **Operate** (menyelesaikan tugas), **Read** (memahami), **Persuade** (memutuskan/bertindak), **Experience**. Hampir semuanya Operate/Read; storefront P3 adalah Persuade.

Data demo: organisasi fiktif **Kestrel Run Co.** (sepatu lari), AUD, GST 10% **[V15]**. Lokasi: Fitzroy, South Yarra (Melbourne, UTC+10/+11), Fremantle (Perth, UTC+8), Newcastle (Sydney zone), Dandenong DC (gudang). Semua data **synthetic**.

| ID | Layar | Permukaan · Peran | Mode | Fitur | Fase | Mockup |
|---|---|---|---|---|---|---|
| S01 | Sign in (PIN) | POS · kasir | Operate | F2 | P1 | — |
| S02 | Open register (float) | POS · kasir | Operate | F8 | P1 | — |
| S03 | Sell | POS · kasir | Operate | F6 | P1 | **ya** |
| S04 | Payment | POS · kasir | Operate | F7 | P1 | **ya** (panel) |
| S05 | Receipt | POS · kasir | Operate | F7 | P1 | ya (di S04) |
| S06 | Customer attach / quick create | POS · kasir | Operate | F6, F10 | P1 | — |
| S07 | Orders lookup / refund / recall parked | POS · kasir | Operate | F9 | P1 | — |
| S08 | Cash movement | POS · kasir | Operate | F8 | P1 | — |
| S09 | Close register | POS · kasir/manager | Operate | F8 | P1 | — |
| S10 | Shift (clock in/out, sesi saya) | POS · kasir | Operate | F13, F22 | P1/P2 | — |
| S11 | Sync & device status | POS · kasir | Read | F12 | P1 | — |
| S12 | Stock on the floor (genggam) | POS · kasir | Operate | F4, F16, F17 | P1/P2 | — |
| S20 | Today (per lokasi / semua) | Admin · semua | Read | F11 | P1 | — |
| S21 | Registers & sessions (daftar, detail, laporan Z) | Admin · store manager | Read | F8, F11 | P1 | **ya** |
| S22 | Orders (daftar, detail, refund) | Admin | Operate | F9, F10 | P1 | — |
| S23 | Customers | Admin | Operate | F10, F19 | P1 | — |
| S24 | Products & variants | Admin | Operate | F3 | P1 | — |
| S25 | Price books & promotions | Admin | Operate | F18 | P2 | — |
| S26 | Inventory (level + kartu stok) | Admin | Read/Operate | F4 | P1 | **ya** |
| S27 | Purchase orders | Admin · purchaser | Operate | F14 | P2 | — |
| S28 | Suppliers | Admin · purchaser | Operate | F14, F15 | P2 | — |
| S29 | Transfers | Admin | Operate | F16 | P2 | — |
| S30 | Stock counts | Admin | Operate | F17 | P2 | — |
| S31 | Gift cards & store credit | Admin | Operate | F19 | P2 | — |
| S32 | Supplier bills & payments | Admin · finance | Operate | F15 | P2 | — |
| S33 | Schedule (roster) | Admin · roster | Operate | F20 | P2 | — |
| S34 | Timesheets | Admin · roster/manager | Operate | F21 | P2 | — |
| S35 | Attendance terminals & devices | Admin · teknisi | Operate | F22, F27 | P2 | — |
| S36 | Commission rules | Admin · owner/finance | Operate | F23 | P2 | — |
| S37 | Commission statements | Admin · owner/finance | Read | F23 | P2 | — |
| S38 | Reports (pustaka + penampil) | Admin | Read | F11, F24 | P1/P2 | — |
| S39 | Report access (grants) | Admin · owner | Operate | F24 | P2 | — |
| S40 | End-of-day schedules | Admin · owner/manager | Operate | F26 | P2 | — |
| S41 | Alerts & notification rules | Admin | Operate/Read | F25 | P2 | — |
| S42 | Staff & roles | Admin · owner | Operate | F2 | P1 | — |
| S43 | Locations, registers, tax, receipts, tenders | Admin · owner | Operate | F1, F7 | P1 | — |
| S44 | Audit log | Admin · owner | Read | F2 | P1 | — |
| S45 | Online store | Admin | Operate | F29 | P3 | — |
| S46 | Marketing & loyalty | Admin | Operate | F31, F32 | P3 | — |
| S47 | Integrations & accounting export | Admin · owner/finance | Operate | F30, F33 | P2/P3 | — |
| S48 | Sign in & 2FA | Admin | Operate | F2 | P1 | — |
| S60 | Portal sign in (kode email) | Portal | Operate | F24 | P2 | — |
| S61 | My reports | Portal | Read | F24 | P2 | — |
| S62 | Report viewer (lingkup terlihat) | Portal | Read | F24 | P2 | — |
| S70 | Bridge status | Bridge · teknisi | Read | F22, F27 | P2 | — |
| S71 | Bridge pairing | Bridge · teknisi | Operate | F22 | P2 | — |
| S80 | Storefront catalog | Storefront · pelanggan | Persuade | F29 | P3 | — |
| S81 | Product page + ketersediaan per toko | Storefront | Persuade | F29 | P3 | — |
| S82 | Checkout / ambil di toko | Storefront | Operate | F29 | P3 | — |
| S83 | Order status | Storefront | Read | F29 | P3 | — |

## Layar yang dimockup

### S03/S04/S05 — POS Sell, Payment, Receipt
- **Tujuan:** menyelesaikan penjualan cepat dan benar, tetap bisa jalan tanpa jaringan.
- **Konteks pemakaian:** iPad landscape di meja kasir, cahaya toko terang, satu tangan sering memegang barang/pemindai; target sentuh ≥ 48px; ratusan transaksi per shift.
- **Isi:** bilah kiri (Sell, Orders, Cash, Stock, Shift, Sync); area tengah: kotak pencarian/scan di atas, grid favorit & hasil pencarian varian (nama, ukuran/warna, harga, stok lokasi ini); panel kanan: keranjang (baris, qty stepper, diskon baris), pelanggan terlampir, total dengan GST, tombol Pay. Kepala: lokasi · register · kasir · status sesi · **indikator Sync/Offline**. Pada Payment: tender (Cash, Card, Gift card, Store credit), split, kembalian, pecahan cepat. Receipt: struk "kertas termal" bertitik-penghubung (dot-leader).
- **Aksi:** utama Pay; sekunder: Park, Attach customer, Discount (berizin, alasan), Void line, No sale (berizin).
- **State:** keranjang kosong; offline (spanduk persisten + hitungan antrean, penjualan tetap lanjut); stok 0/negatif (peringatan, tidak memblokir); izin ditolak (minta PIN manajer); gift card offline dinonaktifkan; antrean sinkron gagal (mengarah S11); barcode tak dikenal; data panjang (nama produk panjang terpotong dengan tooltip, 30 baris keranjang scroll).
- **Data contoh:** "Tempra Glide 3 · Men's 10.5 · Black/White · A$219.95" (merek fiktif), kaos merino A$89.00 diskon 10% disetujui manajer, kaus kaki ×2 A$34.00 = total A$368.05 (GST termasuk A$33.46); offline sejak 11:02 dengan 3 penjualan tersimpan; kasir Priya N.; register FIT-2; Fitzroy.

### S21 — Registers & sessions (detail sesi + laporan Z)
- **Tujuan:** memahami apa yang terjadi di satu register hari ini dan apakah kas cocok.
- **Konteks:** store manager/finance di laptop saat tutup toko atau meninjau kemarin; sering dibuka untuk memeriksa selisih.
- **Isi:** daftar sesi (register, kasir, buka–tutup, penjualan, selisih) di kiri; detail sesi: **kertas tutup kas** (Opening float, Cash sales, Cash refunds, Pay-ins/outs, Drops, Expected, Counted, Variance dengan dot-leader), linimasa peristiwa (clock-in, buka, penjualan besar, no-sale, refund, tutup) yang menyandingkan punch terminal, rincian tender, dan flag sinkron.
- **Aksi:** utama Approve variance (dengan catatan); sekunder: Export Z-report, Open order, Reopen (hanya owner, tercatat).
- **State:** sesi masih terbuka (live, perkiraan); ada perintah offline belum sinkron (`provisional`); selisih besar; izin lokasi saja; nol penjualan; sesi ditutup paksa.
- **Data contoh:** FIT-2, Priya N., 08:57–17:34, float A$300.00, expected A$1,215.40, counted A$1,210.40, variance −A$5.00; net sales A$4,602.00 (47 penjualan); 2 no-sale (09:41 beralasan, 13:12 tanpa alasan); punch in 08:49 (terminal); offline 11:02–11:09, 3 penjualan disinkron 11:10.

### S26 — Inventory (level per lokasi + kartu stok)
- **Tujuan:** melihat stok setiap varian di setiap lokasi dan menelusuri asal angkanya.
- **Konteks:** purchaser/HQ manager di laptop; memeriksa kekurangan, transfer, dan penyesuaian.
- **Isi:** matriks varian × lokasi (on hand, committed, incoming, in transit) dengan lensa lokasi dari rail; panel detail varian: **kartu stok** (buku besar bertanggal: jenis, sumber, ±qty, saldo berjalan, biaya) yang selalu menjumlah ke saldo; transfer dalam perjalanan terlihat sebagai kolom terpisah.
- **Aksi:** utama Adjust stock (menyebut lokasi di label, alasan wajib); sekunder: Create transfer, Start count, Create PO draft, Export.
- **State:** stok negatif (flag penjualan offline), kosong (belum ada pergerakan), varian tak dilacak, pemeriksa malam menemukan selisih proyeksi (banner), izin lokasi.
- **Data contoh:** Tempra Glide 3 M10.5 Black/White: Fitzroy 6, South Yarra 3, Fremantle −1 (flag), Newcastle 4, Dandenong DC 48, in transit 12 (TR-0231); kartu stok Fremantle: transfer_in +6 (TR-0209), sale −1/−2/−1/−1, count_adjust −1 (CC-044), sale offline −1 disinkron terlambat → saldo −1.

## Layar lain (ringkas)

Setiap blok: tujuan · isi/aksi utama · state penting.

- **S01 Sign in (PIN):** pilih kasir (daftar nama atau scan kartu), keypad PIN besar; state: salah PIN (sisa percobaan), terkunci, belum clocked-in (opsi PIN-clock dengan flag), perangkat belum dipasangkan.
- **S02 Open register:** hitung float per pecahan, bandingkan dengan float standar, tanda tangan PIN; state: sesi sebelumnya belum ditutup (paksa tutup/lanjutkan), float berbeda (alasan).
- **S06 Customer:** cari nama/telepon/email, buat cepat, lihat kredit/gift card saldo; state: duplikat, offline (hanya replika).
- **S07 Orders/refund:** cari struk/pelanggan/barcode; pilih baris, alasan, tender pengembalian; kebijakan batas; recall parked; state: sudah direfund sebagian, penjualan dari perangkat lain belum tersinkron ("belum terlihat di perangkat ini").
- **S08 Cash movement:** pay-in/pay-out/drop dengan alasan dan bukti; no-sale hanya manajer atau berizin; state: tanpa izin, jumlah di atas batas.
- **S09 Close register:** hitung per pecahan, buta opsional, selisih, serah ke manajer; mencetak Z; state: ada penjualan belum sinkron (tahan tutup final, tutup sementara), selisih besar butuh PIN manajer.
- **S10 Shift:** status clock (sumber: terminal/PIN), jam hari ini, istirahat, sesi saya; state: terminal tidak terhubung, punch menunggu persetujuan.
- **S11 Sync:** antrean perintah, terakhir sinkron, skew jam, pengecualian untuk perangkat ini, ekspor darurat; state: antrean macet, penyimpanan penuh, versi aplikasi kedaluwarsa.
- **S12 Stock on the floor:** scan untuk cek stok semua lokasi, terima transfer, hitung siklus; state: tak terhubung (replika dengan tanggal data).
- **S20 Today:** penjualan langsung vs kemarin, register terbuka, kas di laci, perangkat offline, pengecualian terbuka, jadwal vs hadir; state: toko tutup, hari libur, semua lokasi vs satu.
- **S22 Orders:** filter lokasi/kasir/tender/flag; detail dengan garis waktu (dibuat di perangkat, diterima server, refund); state: flag `price_mismatch`, `negative_stock`.
- **S23 Customers:** profil, riwayat, saldo kredit/gift card, persetujuan marketing; state: kandidat gabung.
- **S24 Products:** daftar + editor varian (opsi, barcode, pajak, pemasok), impor CSV; state: SKU kembar (menolak dengan penjelasan), varian tanpa barcode.
- **S25 Price books:** buku harga berlaku-tanggal per lokasi/grup, pratinjau harga akhir, promosi; state: tumpang tindih dengan prioritas ditampilkan.
- **S27 PO:** buat/setujui/kirim, penerimaan parsial, biaya mendarat; state: terlambat, kelebihan kirim.
- **S28 Suppliers:** kontak, syarat bayar, produk, riwayat PO.
- **S29 Transfers:** dua kaki dengan status, penerimaan selisih; state: macet dalam perjalanan > N hari.
- **S30 Stock counts:** buat sesi (penuh/siklus), hitung buta, tinjau selisih, komit sebagai delta; state: penjualan terjadi sejak snapshot.
- **S31 Gift cards:** terbit, saldo, buku besar entri, blokir; store credit per pelanggan; state: overdraft offline.
- **S32 Bills:** tagihan, cocokkan dengan penerimaan, bayar, aging; state: tagihan tak cocok.
- **S33 Schedule:** papan minggu per lokasi, templat, publikasi; state: bentrok, di bawah kebutuhan.
- **S34 Timesheets:** punch → entri, selisih vs shift, koreksi dengan alasan, setujui; state: punch `needs_review`, lupa clock-out.
- **S35 Terminals & devices:** status terminal, daftar enrol (status saja), bridge sehat, printer, pairing; state: terminal diam > N menit, kode person tak dikenal.
- **S36/S37 Komisi:** editor aturan berversi dengan pratinjau hitung, pernyataan per kasir dengan rincian per baris penjualan, kunci periode.
- **S38 Reports:** pustaka (Sales, Z-report, Stock valuation, Staff hours, Commission, Cash variance); penampil dengan tautan ke transaksi.
- **S39 Report access:** pembuat grant (pengguna, laporan, lokasi, rentang tetap/bergulir, kolom disembunyikan, kedaluwarsa), pratinjau "yang akan dilihat orang ini", log tampilan.
- **S40 EOD schedules:** penerima, jam lokal, hari, metode (email/webhook), kondisi "hanya saat semua register tutup", riwayat kiriman berstatus sementara/final/koreksi.
- **S41 Alerts:** log kejadian + aturan (clock in/out, register buka/tutup, no-sale, selisih, refund besar), jam tenang.
- **S42 Staff & roles:** pengguna, peran × lokasi, PIN reset, status enrol terminal, nonaktifkan.
- **S43 Locations:** lokasi/register/zona waktu/batas hari bisnis, kelas pajak, templat struk, metode bayar, kebijakan offline gift card.
- **S44 Audit log:** filter aktor/aksi/subjek; diff sebelum–sesudah.
- **S45–S47 (P3):** kanal toko online dan ambil di toko; segmen, kampanye, alur dengan pratinjau jangkauan; integrasi Shopify/Xero dengan log sinkron.
- **S48 Sign in:** email+sandi, TOTP, pemulihan.
- **S60–S62 Portal:** kode email; daftar laporan yang diizinkan; penampil dengan spanduk lingkup tetap ("Fitzroy · 1–31 Oct 2026 · cost columns hidden") dan keadaan "Access ended".
- **S70/S71 Bridge:** halaman status lokal (terminal, printer, antrean keluar, log, versi); pairing dengan kode 8 karakter dari S35.
- **S80–S83 (P3):** katalog, PDP dengan ketersediaan per toko, checkout/ambil di toko, status pesanan.
