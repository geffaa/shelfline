# Tech Spec — Shelfline

Klaim yang bergantung pada perangkat keras, platform Apple, atau layanan pihak ketiga ditandai **[V##]** dan didaftar di §10. Semuanya perlu diuji pada perangkat nyata sebelum dipakai sebagai klaim di portfolio.

## 1. Arsitektur

```
 iPad POS (PWA, Dexie/IndexedDB; P2: Capacitor + SQLite)          Portal (SPA, token audience=portal)
   │  push: perintah idempoten  ▲ pull: perubahan sejak kursor      │
   ▼                            │                                    ▼
 ┌──────────────────────── NestJS modular monolith (satu proses) ───────────────────────────┐
 │ identity │ catalog │ stock-ledger │ sales │ cash │ people │ purchasing │ commission │    │
 │ reporting │ notify │ sync │ devices │ channels(P3) │ marketing(P3)                       │
 │          Drizzle (skema dimiliki migrasi)         outbox + scheduled_job (worker)        │
 └──────────────┬───────────────────────────────────────────────────────┬───────────────────┘
                │ PostgreSQL (satu-satunya penyimpanan tahan lama)      │ SSE (LISTEN/NOTIFY) ke Admin
                ▼                                                       ▼
        change_log, ledger, outbox                       Admin (SPA)  ·  Storefront Next.js (P3)

 Jaringan toko:  Terminal absensi ──HTTP LAN──► Bridge (Go) ──TLS, batch bertanda──► API /devices
                 iPad ──WSS/HTTPS lokal──► Bridge ──TCP 9100──► Printer struk (+ tendang laci)
```

Alasan: satu bahasa (TypeScript) untuk POS, admin, server, dan paket `pricing`/`money` yang **harus identik** di perangkat offline dan di server; satu database sebagai sumber kebenaran tunggal untuk uang dan stok.

## 2. Keputusan stack dan kritik atas usulan awal

Usulan: NestJS modular monolith + PostgreSQL + Redis/BullMQ, POS Next.js PWA offline-first (DB lokal + sinkron, Capacitor bila perlu), admin Next.js, Go hanya untuk jembatan bila terbukti perlu.

| Komponen | Usulan | Keputusan | Alasan tertulis |
|---|---|---|---|
| Backend | NestJS modular monolith | **Dipertahankan** | Batas modul (±12) perlu ditegakkan oleh DI/modul, bukan konvensi; satu bahasa dengan klien. Alternatif Hono/Fastify lebih ringan tetapi tidak memberi struktur modul; layanan terpisah tidak dibenarkan (satu tim, satu basis data transaksi). |
| ORM | — | **Drizzle**, migrasi SQL dimiliki repo | Constraint khusus (unique parsial, exclusion, generated column) lebih jelas di SQL. |
| Database | PostgreSQL | **Dipertahankan** | Buku besar butuh transaksi, `FOR UPDATE`, constraint unik idempotensi, `LISTEN/NOTIFY`. |
| Antrean | Redis + BullMQ | **Ditolak untuk P1–P2: outbox + `scheduled_job` di Postgres** | Setiap efek samping (email, laporan, push stok ke kanal) harus atomik dengan perubahan domain; Redis menambah penyimpanan kedua yang tidak transaksional dan celah "ditulis tapi tidak diantre". Klaim baris dengan `FOR UPDATE SKIP LOCKED`. Job terjadwal (laporan akhir hari, jatuh tempo) adalah baris `scheduled_job` dengan `run_at` dan kunci unik per (jadwal, tanggal bisnis). Redis diperkenalkan hanya jika diukur perlu (cache storefront P3, rate limit terdistribusi). |
| POS | Next.js PWA | **Diubah: Vite + React SPA (PWA), bukan Next.js** | POS adalah aplikasi yang harus hidup tanpa server. RSC/SSR/routing server tidak berguna dan mempersulit service worker (cache shell, versi). Next.js tetap dipakai untuk storefront P3 yang butuh SSR/SEO. |
| Admin | Next.js | **Diubah: Vite + React SPA** | Aplikasi terautentikasi, tanpa kebutuhan SEO; berbagi paket `ui`, `money`, `pricing` dengan POS; satu toolchain dan build lebih sederhana. |
| Portal | — | **SPA terpisah + audiens token terpisah**, proses API yang sama | Permukaan serangan eksternal dipersempit ke prefiks `/portal/*`; bisa di-deploy ke subdomain berbeda. |
| DB lokal POS | "DB lokal + sinkron" | **Dexie (IndexedDB) di PWA; SQLite via Capacitor di P2**, di balik antarmuka `LocalStore` | IndexedDB cukup untuk katalog puluhan ribu SKU; SQLite native menghindari eviksi penyimpanan Safari **[V01][V02]** dan dibutuhkan saat membungkus. Dua adaptor, satu kontrak, diuji dengan suite yang sama. |
| Mesin sinkron | (tak disebut) | **Dibuat sendiri: log perintah append-only + tarik berbasis kursor**; bukan CRDT, bukan PowerSync/ElectricSQL | Domain ini sebagian besar *peristiwa tak berubah* (penjualan, kas, punch) dan sedikit status yang bisa diubah dan berbagi (katalog, pelanggan). CRDT berlebihan; layanan pihak ketiga menambah ketergantungan dan biaya yang perlu verifikasi. Dikritik: menulis sinkron sendiri berisiko; mitigasi di §5.1 dan strategi tes §8 (tes properti dan 10 klien acak). |
| Jembatan perangkat | Go bila terbukti perlu | **Go, terbukti perlu pada satu kriteria: dipasang di perangkat toko non-teknis** | Biner statis lintas-kompilasi (ARM Pi, Windows mini-PC, macOS), tanpa runtime, layanan latar yang tahan lama, TCP mentah ke printer, server HTTP untuk push terminal. Node akan menuntut instalasi runtime atau biner SEA besar dan modul native untuk USB. Dibatasi kecil (adaptor terminal, relay printer, antrean keluar lokal). Kontrak JSON dari skema bersama (`packages/contracts`). Jika di demo bridge tidak dipasang, simulator di server memainkan peran yang sama. |
| Realtime admin | — | SSE dari `LISTEN/NOTIFY` | Satu arah cukup (papan Hari Ini); tidak perlu WebSocket. |
| Auth | — | Admin: email+sandi (Argon2id)+TOTP; POS: PIN per kasir di perangkat terdaftar; Portal: kode sekali pakai lewat email; Bridge: kunci perangkat hasil pairing | Ditulis dari nol. |

Versi: stabil terbaru saat menulis kode; kunci di lockfile.

## 3. Stack & paket

| Paket | Fungsi |
|---|---|
| `apps/api` (NestJS) | Modul domain, sinkron, worker outbox/jadwal, SSE |
| `apps/pos` (Vite/React, Dexie, Workbox) | Aplikasi kasir offline-first |
| `apps/admin`, `apps/portal` (Vite/React, TanStack Router/Query) | Back-office dan portal |
| `apps/bridge` (Go) | Jembatan perangkat |
| `apps/storefront` (Next.js, P3) | Toko online |
| `packages/money` | Aritmetika uang integer (unit minor), pembulatan, alokasi sisa |
| `packages/pricing` | Harga, diskon, pajak; **dijalankan di POS dan server** dengan vektor uji emas yang sama |
| `packages/contracts` | Skema perintah sinkron, event bridge (zod → JSON Schema → tipe Go) |
| `packages/ui` | Komponen kustom (date picker, combobox, switch, dst.) tanpa kontrol bawaan browser |
| Library | Drizzle, zod, pino, Argon2, otplib, Workbox, Dexie, Radix primitives (headless), Playwright, Vitest |

## 4. Data model (skema `shelfline`)

Semua tabel punya `org_id`. Uang disimpan sebagai integer unit minor + `currency`. Waktu disimpan UTC; `local_date` (tanggal bisnis) dihitung dari zona waktu lokasi dan batas hari bisnis.

### 4.1 Identitas dan organisasi (F1, F2)
| Tabel | Kolom penting | Catatan |
|---|---|---|
| `org` | id, name, currency, timezone_default | satu per deployment (siap banyak) |
| `location` | id, org_id, code, name, type (`store`/`warehouse`/`transit`/`virtual`), timezone, day_cutoff (time), tax_region, status | `transit` dibuat otomatis per transfer |
| `register` | id, location_id, code (unik per org), name, status | kode dipakai di prefiks nomor struk |
| `device` | id, org_id, kind (`pos`/`bridge`/`terminal`/`printer`), location_id, register_id?, serial, key_hash, last_seen_at, clock_skew_ms | kunci perangkat hasil pairing |
| `user` | id, org_id, email, name, password_hash, totp_secret (terenkripsi), status | |
| `staff_profile` | user_id, employee_code, terminal_person_code (unik per terminal group), pin_hash, pin_attempts, hired_on, ended_on | PIN Argon2id; **tidak ada data biometrik** |
| `role`, `role_permission`, `user_assignment` | permission string; assignment = (user, role, location_id\|null) | peran dibaca ulang tiap request |
| `audit_log` | actor, action, subject_type/id, before/after jsonb, at, ip, device_id | tak bisa diubah (revoke UPDATE/DELETE) |

### 4.2 Katalog (F3, F18)
| Tabel | Kolom penting |
|---|---|
| `product` | id, org_id, title, category_id, tax_class_id, brand, supplier_default_id, status |
| `variant` | id, product_id, sku (unik per org, normalisasi trim+lower), barcode (unik parsial), options jsonb, base_price_minor, track_stock, cost_method |
| `category`, `tax_class`, `tax_rate` (class, region, rate_bp, tax_inclusive, valid_from/to) | pajak berlaku-tanggal |
| `price_book`, `price_book_location`, `price_book_entry` (M11) | scope = semua lokasi bila `price_book_location` kosong, valid_from/to inklusif (tanggal bisnis), prioritas, `version` naik tiap perubahan (termasuk entri); entry = (variant, price_minor) |
| `promotion`, `promotion_variant`, `promotion_location` (M11) | tipe `percent` / `amount_off` (beli-X-gratis-Y belum), min_qty, stackable, valid_from/to; tanpa baris varian/lokasi = semua |
| `catalog_version` | seq, at — naik tiap perubahan katalog; dipakai kursor tarik |

### 4.3 Buku besar stok (F4, F14, F16, F17)
| Tabel | Kolom penting | Constraint |
|---|---|---|
| `stock_movement` | id, org_id, variant_id, location_id, qty_delta (int, ±), kind, source_type, source_id, line_no, unit_cost_minor?, reason, at, local_date, device_id?, flags | **unik (source_type, source_id, line_no, kind)** → idempotensi; tabel append-only (tanpa UPDATE/DELETE di role aplikasi) |
| `stock_balance` | variant_id, location_id, on_hand, reserved, incoming, avg_cost_minor, version | proyeksi; diperbarui dalam transaksi yang sama dengan movement; `on_hand = SUM(qty_delta)` diverifikasi pemeriksa malam |
| `transfer`, `transfer_line`, `transfer_receipt(+_line)` (M10) | from/to location, status (`draft`→`sent`→`partial`→`received`/`cancelled`), transit_location_id (dibuat saat kirim, `type=transit`, disembunyikan), qty_sent/received/variance (CHECK jumlah ≤ sent), kunci idempotensi penerimaan, penerimaan tak bisa diubah (trigger) | |
| `stock_count`, `stock_count_line` (M10) | scope, mode (blind), snapshot_at, expected_at_snapshot, counted_qty, status | penyesuaian = delta terhadap saldo saat komit, bukan menimpa |
| `purchase_order`, `po_line`, `receipt`, `receipt_line` (P2) | supplier, status, expected_on, qty_ordered/received, unit_cost_minor, landed_cost_alloc | |

`kind` ∈ `sale`, `refund_return`, `receive_po`, `manual_receive`, `transfer_out`, `transfer_in`, `transfer_variance`, `count_adjust`, `manual_adjust`, `write_off`, `online_reserve`, `online_release`, `opening_balance`.

### 4.4 Penjualan, kas, pelanggan (F6–F10)
| Tabel | Kolom penting | Catatan |
|---|---|---|
| `register_session` | id (UUIDv7 dari klien), register_id, opened_by, closed_by, opened_at, closed_at, opening_float_minor, counted_close_minor, expected_close_minor (dihitung server), variance_minor, status, count_breakdown jsonb | |
| `cash_movement` | id, session_id, kind (`pay_in`,`pay_out`,`drop`,`float_add`,`no_sale`), amount_minor, reason, actor_id, at | `no_sale` bernilai 0 |
| `sale` | id (UUIDv7 klien), receipt_no (`<REG>-<seq>`, unik per register), session_id, location_id, register_id, cashier_id, customer_id?, channel, status, subtotal/discount/tax/total_minor, price_snapshot jsonb (price_book_id, version), client_ts, received_at, local_date, flags | tak berubah setelah dibuat; koreksi = refund |
| `sale_line` | sale_id, line_no, variant_id, qty, unit_price_minor, discount_minor, tax_minor, attributed_to (user), refunded_qty (proyeksi) | |
| `payment` | sale_id/refund_id, tender (`cash`,`card`,`gift_card`,`store_credit`,`other`), amount_minor, reference, change_minor | |
| `refund`, `refund_line` | sale_id, line_no, qty, reason, approved_by, tender, client_ts | `over_refund` diberi flag, bukan ditolak |
| `customer` | id, name, email, phone, marketing_consent jsonb, notes, merged_into? | field-level LWW |
| `parked_sale` | id, device_id, payload jsonb | lokal + server (opsional) |

### 4.5 Orang, waktu, komisi (F13, F20–F23)
| Tabel | Kolom penting |
|---|---|
| `punch` | id, user_id, location_id, kind (`in`/`out`), method (`terminal_fp`,`pin`,`manual`), source_device_id, client_ts, received_at, clock_skew_ms, status (`accepted`,`needs_review`), supersedes_id? |
| `shift`, `shift_template` (P2) | location, user, starts_at, ends_at, role, published_at |
| `timesheet_entry` (P2) | user, local_date, punch_in_id, punch_out_id, worked_minutes, break_minutes, variance_vs_shift, status (`open`,`submitted`,`approved`), adjusted_by |
| `terminal_enrollment` (P2) | device_id, user_id, terminal_person_code, status, last_seen_at — hanya status, **bukan template** |
| `commission_rule` (P2) | id, rule_set_id, version, valid_from/to, scope (lokasi/kategori/merek/varian), basis (`net_ex_tax`,`margin`), rate_bp atau tiers jsonb, split_mode (`seller`,`equal`,`weighted`,`hours_pool`) |
| `commission_entry` (P2) | id, user_id, sale_id/refund_id, line_no, rule_id+version, amount_minor (±), period_id, kind (`earn`,`clawback`,`adjust`), unik (source, line_no, user, rule_version) |
| `commission_period`, `commission_statement` | rentang, status (`open`,`locked`,`paid`) |

### 4.6 Pelaporan, izin, notifikasi (F11, F24–F26)
| Tabel | Kolom penting |
|---|---|
| `report_definition` | key, params schema, kolom (tandai kolom sensitif: `cost`, `margin`) |
| `report_grant` | id, grantee_user_id, report_keys[], location_ids[]\|null, range_kind (`fixed`,`rolling`), range_from/to atau rolling_days, hidden_columns[], expires_at, created_by |
| `report_view_log` | grant_id, user_id, params, at |
| `eod_schedule` | id, location_ids[], send_at_local (time), days_of_week, timezone, channels jsonb (email/webhook/…), recipients jsonb, format (`pdf`,`csv`,`inline`), only_when_closed, active |
| `eod_report_run` | schedule_id, local_date, version, status (`provisional`,`final`,`amended`), generated_at, delivered jsonb |
| `notification_rule` | event_kind, location_ids, conditions jsonb (mis. variance > X), recipients, channels, quiet_hours, digest |
| `notification` | id, rule_id, event_ref, payload, status, delivered_at |

### 4.7 Keuangan vendor (F15) — dibangun di M9
| Tabel | Aturan |
|---|---|
| `supplier` | nama unik (tanpa membedakan huruf), `terms_days` 0–365, `active`/`archived` (pemasok terarsip tidak bisa dipesan) |
| `purchase_order`, `po_line` | status `draft`→`sent`→`partial`→`received` (`closed` = sisa dibatalkan, `cancelled` hanya tanpa penerimaan); satu varian sekali per PO; `qty_received ≤ qty_ordered` (CHECK); nomor dari sequence `PO-000001` |
| `receipt`, `receipt_line` | **tidak bisa diubah/dihapus (trigger)**; kunci idempotensi per penerimaan; `freight_minor`/`other_cost_minor` dibagi ke baris menurut nilai (largest remainder → jumlah tepat); `landed_unit_cost_minor` = (nilai + bagian) / qty dibulatkan, itulah biaya yang masuk ke buku besar (`receive_po`) dan rata-rata bergerak; HPP penjualan berikutnya memakai rata-rata itu |
| `supplier_bill`, `bill_line` | satu nomor tagihan per pemasok (tanpa membedakan huruf); jatuh tempo = tanggal tagihan + termin bila tidak diisi; status `held`→`open`→`partially_paid`→`paid` (`void` hanya tanpa pembayaran) |
| `bill_receipt_match` | satu baris per baris tagihan yang terkait baris PO: ditagih (kumulatif lintas tagihan hidup) vs diterima, dan harga tagihan vs harga PO. **Ditahan (`held`) bila ditagih > diterima atau harga ≠ PO**; pembayaran ditolak (`bill_held`). Dilepas otomatis ketika penerimaan berikutnya membuat tagihan cocok; atau disetujui finance dengan alasan (disimpan + audit). |
| `bill_payment` | tidak bisa diubah/dihapus (trigger); kunci idempotensi; tidak boleh melebihi sisa; metode `bank_transfer`/`card`/`cash`/`other` |
| aging | sisa (total − dibayar) tagihan `held`/`open`/`partially_paid` per pemasok dalam ember hari lewat jatuh tempo: belum jatuh tempo, 1–30, 31–60, 61–90, 90+; jumlah yang ditahan ditampilkan terpisah |

Izin: `purchase:read|write` (purchaser, HQ), `bill:read|write` (finance, purchaser/HQ baca), `bill:approve` (finance, owner). Penerimaan diperiksa terhadap `inventory:write` di lokasi PO, jadi manajer toko bisa menerima pesanan tokonya sendiri tanpa melihat keuangan. Tidak dibangun di M9: `stock_balance.incoming` (dipakai saat transfer/replenishment), PO lewat email, persetujuan PO bertingkat.

### 4.8 Gift card dan kredit (F19)
`gift_card` (code hash, issued_at, expires_at, status), `balance_entry` (account_type `gift_card`/`store_credit`, account_id, delta_minor, source_type/id, unik per sumber) — saldo = SUM; penebusan offline lihat §5.4.

### 4.9 Sinkron dan infrastruktur
| Tabel | Kolom penting |
|---|---|
| `change_log` | seq (bigint identity), txid xid8 (`pg_current_xact_id()`), entity_type, entity_id, op, scope (org/location) | 
| `sync_command_receipt` | command_id (unik), device_id, device_seq, result (`accepted`,`duplicate`,`rejected`,`accepted_flagged`), reason, at |
| `sync_exception` | id, kind (`negative_stock`,`price_mismatch`,`over_refund`,`late_sale`,`gift_card_overdraft`,`skewed_clock`), ref, status, resolved_by |
| `outbox` | topic, payload, idempotency_key unik, status, attempts, next_attempt_at, last_error |
| `scheduled_job` | key unik, run_at, handler, payload, status |
| P3: `channel_connection`, `channel_listing`, `online_order`, `segment`, `campaign`, `flow`, `flow_run`, `loyalty_account`, `loyalty_entry` |

Pemetaan fitur → entitas ada di PRD §8; tiap entitas dipakai minimal satu fitur.

## 5. Logika inti

### 5.1 Mode offline POS dan resolusi konflik sinkron (keputusan)

**Prinsip:** POS tidak mereplikasi basis data; POS (a) menyimpan **replika baca** katalog/harga/pelanggan/izin untuk lokasinya dan (b) menulis **perintah tak berubah** ke antrean lokal. Server adalah otoritas dan *tidak pernah menolak fakta fisik* (barang sudah keluar, uang sudah diterima): anomali diterima dengan flag dan jadi pengecualian terlihat, bukan hilang.

**Replika baca (tarik):** `GET /sync/pull?cursor=<txid>:<seq>`. Kursor `seq` saja **tidak aman** (diputuskan 2026-11-04 setelah dirancang ulang): `seq` identity dialokasikan saat INSERT, bukan saat commit, dan transaksi dengan `txid` lebih rendah bisa mendapat `seq` lebih tinggi, jadi baris dengan `seq` lebih kecil bisa baru terlihat setelah klien melewatinya. Aturan yang dipakai: tiap perubahan ditulis ke `change_log` oleh trigger dengan `txid xid8`; server hanya menyajikan baris dengan `txid < pg_snapshot_xmin(pg_current_snapshot())` (semua transaksi yang lebih tua sudah selesai), diurutkan menurut `(txid, seq)`, dan kursor yang dikembalikan saat habis adalah `(horizon, -1)`. Karena xmin tidak pernah mundur, tidak ada baris yang bisa muncul di belakang kursor. Perubahan pada entitas yang sama digabung (state terbaru dibaca sekali per tipe). Konsekuensi yang diterima: transaksi lama (atau `idle in transaction`, atau transaksi di database lain pada kluster yang sama) menahan `horizon` sehingga data baru tertunda sampai transaksi itu selesai; perlu dipantau. Diuji dengan dua koneksi `pg` mentah (V17 dan V17b). Unduhan awal (`/sync/snapshot`) mengambil kursor **sebelum** membaca data, per tipe entitas dengan paginasi keyset; perubahan yang masuk selama unduhan ikut terkirim lagi lewat tarik (idempoten). Isi replika sengaja sempit: tanpa biaya, tanpa staf, hanya lokasi perangkat itu.

**Antrean tulis (dorong):** setiap perubahan POS adalah perintah `{id: UUIDv7, device_id, device_seq, type, payload, client_ts, schema_v}` yang ditulis ke `outbox_local` **dalam transaksi lokal yang sama** dengan perubahan UI-state (sale selesai ↔ perintah antre, atomik). `POST /sync/push` menerima batch berurutan per perangkat; server memproses tiap perintah dalam transaksi sendiri dan mengembalikan hasil per perintah. Perintah dengan `id` yang sudah ada → `duplicate` (idempoten). Perintah tidak boleh melompati `device_seq`; celah → menunggu/alert.

**Aturan dorong yang berlaku (M4):** `device.last_seq` + `unique(device_id, device_seq)`; perintah dengan nomor melompat dijawab `gap` dan tidak dijalankan; perintah yang sudah punya receipt dijawab `duplicate` **dengan hasil aslinya** (klien harus tetap menampilkan penolakan/flag dari respons yang hilang, ditemukan lewat tes model); penolakan yang sah (tipe tak dikenal, payload salah, izin, aktor tak ditugaskan, versi skema) dicatat sebagai `rejected`, memajukan urutan, dan tidak memblokir perintah berikutnya; kesalahan tak terduga menghentikan batch (`halted`) tanpa receipt sehingga klien mengirim ulang. Aktor perintah adalah kasir saat perintah dibuat (bukan pemilik token saat sinkron) dan harus aktif serta ditugaskan di lokasi perangkat. Handler berjalan dalam savepoint: penolakan bisnis membatalkan efek sebagian tetapi receipt tetap tercatat. Kode di dalam transaksi hanya boleh memakai handle `tx` (jangan memanggil `db` lagi): 10 push serentak menghabiskan pool koneksi dan macet sebelum aturan ini ditegakkan.

**Penjualan (M5):** `sale.create` menghitung ulang dengan `@shelfline/pricing` dari harga satuan dan diskon yang dibawa mesin kasir (server tidak mengganti harga katalog yang sudah berubah); total mesin kasir tetap dipakai bila beda dan diberi `price_mismatch` dengan kedua angka di `sync_exception`. Diskon di atas batas kasir (`location.cashier_discount_limit_bp`, default 10%) harus membawa token persetujuan manajer (`POST /pos/approve`: PIN manajer diverifikasi online, token JWT audiens `approval` berlaku 10 menit, terikat ke perangkat, lokasi, dan jenis); tanpa token, penjualan diterima dan diberi `discount_unapproved`. Hanya varian yang tak dikenal server yang ditolak (tidak bisa dicatat). Mesin kasir menulis catatan struk lokal dan perintah antre **dalam satu transaksi lokal** bersama nomor struk berikutnya (`<KODE-REGISTER>-<urut 6 digit>`); stok yang tampil = replika − unit yang belum dikonfirmasi server.

**Kas dan refund (M6):** satu fungsi `zReport` (SQL) mendefinisikan "kas diharapkan" = float + penjualan tunai − refund tunai + pay-in + tambah float − pay-out − drop (uang diterapkan, tanpa kembalian); kasir menghitung salinan sementaranya dengan aritmetika yang sama dan angka server saat `session.close` bersifat final. Persetujuan manajer memakai token bertanda tangan terikat perangkat, lokasi, dan jenis (`discount`, `variance`, `refund`; izin `sale:approve_discount` atau `cash:approve`). Refund: jumlah per baris dihitung `refundAmount` (unit terakhir mengambil sisa total dan pajak baris, jadi refund bertahap menjumlah persis); server memakai jumlah yang dibawa kasir (uang sudah keluar) dan menandai `refund_amount_mismatch`, `refund_total_mismatch`, `over_refund`, `refund_unapproved`; barang kembali ke rak lokasi perangkat sebagai `refund_return` kecuali ditandai rusak. Kejadian laci tanpa alasan (`no_sale_no_reason`) ditandai, bukan ditolak.

**Matriks konflik per jenis data:**

| Data | Dibuat offline? | Strategi | Bila bentrok |
|---|---|---|---|
| Penjualan, pembayaran | Ya | Tak berubah, ID dari klien, nomor struk per register (`FIT2-000123`) — tidak ada penomoran global | Selalu diterima. Stok negatif → `negative_stock`; total server ≠ total perangkat → total perangkat dipakai (pelanggan sudah membayar) + `price_mismatch` |
| Sesi register, cash movement, no-sale | Ya | Tak berubah; satu sesi per register (constraint unik sesi terbuka) | Dua sesi terbuka di register yang sama (perangkat ganti) → sesi lama ditutup paksa dengan flag `needs_review` |
| Refund | Ya | Tak berubah; terhadap `sale_line` asli | Total refund melebihi qty asli (dua perangkat) → diterima + `over_refund` |
| Punch clock | Ya | Tak berubah, `client_ts` + `clock_skew_ms` | Punch ganda dalam jendela pendek → yang kedua `needs_review`; koreksi hanya entri baru (`supersedes_id`) |
| Penerimaan transfer, hitung stok genggam | Ya (antre) | Delta, bukan nilai absolut | Dijumlahkan ke buku besar; selisih terhadap saat snapshot jadi varian |
| Gift card / store credit ditebus | **Tidak secara default** | Perlu online, atau offline terbatas (§5.4) | Overdraft → `gift_card_overdraft` |
| Katalog, harga, izin, pengguna | **Tidak** (hanya baca di POS) | Server otoritas, berversi | Baris penjualan membawa snapshot harga yang dipakai; server tidak menghitung ulang diam-diam |
| Pelanggan (buat/ubah) | Ya (antre) | Gabung per-field last-write-wins berdasarkan `received_at` server; email unik → dedup | Bentrok email → antre sebagai `merge_candidate` |
| Bayar kartu | **Tidak offline** (P2) | Terminal menolak tanpa jaringan **[V11]**; fallback "kartu manual (ditandai)" di P1 hanya sebagai catatan tender |

**Jam perangkat tidak dipercaya.** Setiap sinkron mengukur `clock_skew_ms` (selisih jam server pada respons vs jam perangkat). Tanggal bisnis memakai `client_ts` dikoreksi skew bila |skew| < 5 menit; jika lebih, memakai `received_at` dan menambah flag `skewed_clock`.

**Penyimpanan dan kehilangan data:** PWA meminta `navigator.storage.persist()` dan menampilkan peringatan jika ditolak; antrean berisi perintah yang belum disinkron ditampilkan di S11 dan ada ekspor manual (JSON) sebagai jalan darurat. Penyimpanan Safari bisa dievik **[V01][V02]**; karena itu P2 membungkus dengan Capacitor + SQLite **[V06]**. Tanpa Background Sync di Safari **[V04]**, sinkron berjalan saat aplikasi di latar depan: interval + saat `online` + saat selesai transaksi.

**Versi skema:** perintah membawa `schema_v`; server menerima N versi ke belakang. Aplikasi lama yang terlalu tua ditolak dengan layar "Update required" setelah antrean dikosongkan.

### 5.2 Buku besar stok per lokasi (keputusan)

Dimensi **lokasi**, **jenis** peristiwa terketik, lokasi **transit**, **biaya**, dan **proyeksi saldo**.

- **Satu-satunya cara mengubah stok adalah menambah `stock_movement`.** Tidak ada UPDATE saldo langsung. Role database aplikasi tidak punya hak UPDATE/DELETE pada tabel ini.
- **Idempotensi:** `UNIQUE (source_type, source_id, line_no, kind)`. Memproses penjualan yang sama dua kali menambah nol baris.
- **Proyeksi `stock_balance`:** diperbarui dalam transaksi yang sama dengan `INSERT movement`, memakai `SELECT ... FOR UPDATE` pada baris saldo dengan urutan kunci terurut (variant_id, location_id) untuk menghindari deadlock. Pemeriksa malam membandingkan `SUM(qty_delta)` dengan `on_hand`; selisih = alarm.
- **Stok negatif diizinkan secara sadar** hanya untuk `sale` (barang fisik sudah keluar); ditandai `negative_stock`. Hanya *pengeluaran* yang bisa membuat atau memperdalam kekurangan: penambahan stok (penerimaan, refund, transfer masuk) selalu diterima walau saldo masih negatif. Penyesuaian manual, write-off, reservasi online, dan transfer keluar tidak boleh membuat saldo negatif (ditolak 409). Peristiwa yang sudah ada di ledger dijawab `duplicate` sebelum aturan stok apa pun (tidak dinilai ulang terhadap stok hari ini).
- **Transfer dua kaki:** kirim → `transfer_out` di lokasi asal, +qty di lokasi `transit` milik transfer itu; terima → −qty di transit, `transfer_in` di tujuan; selisih → `transfer_variance` ke akun selisih. Invarian: jumlah semua lokasi (termasuk transit) konstan untuk transfer.
- **Stock count:** `expected_at_snapshot` disimpan, tetapi penyesuaian = `counted − expected_at_snapshot` ditambahkan sebagai `count_adjust` pada saat komit; penjualan yang terjadi antara snapshot dan komit tidak tertimpa.
- **Biaya:** rata-rata bergerak per (varian, lokasi) diperbarui saat penerimaan/transfer_in; `unit_cost_minor` disalin ke movement penjualan untuk laba kotor. Trade-off: FIFO lebih akurat untuk akuntansi tertentu, tidak dikerjakan (di luar lingkup; **[V15]** aturan akuntansi per negara).
- **Ketersediaan jual** = `on_hand − reserved` (reservasi online/ambil di toko, P3).

### 5.3 Alokasi komisi otomatis (F23)

Deterministik dan dapat dihitung ulang: `commission_entry` diturunkan dari `sale_line`/`refund_line` + versi aturan yang berlaku pada `local_date` penjualan.
1. Pilih aturan: prioritas varian > merek > kategori > lokasi > default; ambil versi dengan `valid_from ≤ local_date`.
2. Dasar: `net_ex_tax` (harga − diskon − pajak) atau `margin` (net − `unit_cost` salinan movement).
3. Pembagian: `seller` (kasir penjualan atau `attributed_to` override), `equal` (kasir yang clocked-in pada saat itu di lokasi), `weighted` (bobot per peran), `hours_pool` (pool harian dibagi menurut menit kerja timesheet; dihitung saat periode ditutup).
4. Sisa pembulatan dialokasikan ke penerima terbesar (paket `money.allocate`).
5. Refund menambah entri `clawback` dengan proporsi sama dan aturan yang sama (bukan aturan terbaru).
6. Periode `locked` tidak berubah; koreksi sesudahnya berupa `adjust` di periode berikutnya.

### 5.4 Kebijakan gift card dan store credit offline
Penebusan offline dimatikan secara default. Opsi per lokasi: izinkan bila kartu dikenal di replika dengan saldo, plafon per transaksi (default rendah), dan hanya satu penebusan offline per kartu per perangkat. Risiko "double-spend" antar dua perangkat diterima sampai plafon dan dicatat sebagai `gift_card_overdraft`; ini keputusan bisnis yang dicatat di PRD asumsi.

### 5.5 Absen sidik jari (keputusan)

**Dipilih: terminal absensi jaringan (identitas dan pencocokan di perangkat) + bridge LAN + peristiwa punch ke Shelfline.** Template sidik jari tidak pernah meninggalkan terminal dan tidak disimpan di Shelfline.

| Opsi | Penilaian |
|---|---|
| **A. Terminal absensi jaringan (mis. keluarga ZKTeco) + bridge** | Dipilih. Perangkat memang dibuat untuk ini; cocok dengan iPad karena POS hanya *menerima* punch lewat server. Risiko: protokol push berbeda per model/firmware dan sebagian HTTP tanpa TLS **[V09]**; bridge di LAN terisolasi meneruskan lewat TLS. |
| B. Aplikasi native iPad + pembaca USB | Ditolak. Browser iOS tidak punya WebUSB/Serial **[V05]**; aplikasi native butuh SDK vendor untuk iPadOS (ketersediaan dan lisensi tidak diverifikasi), pembaca USB di iPad bergantung MFi/driver; pengelolaan template jadi tanggung jawab kita. |
| C. Touch ID/Face ID iPad via WebAuthn | Ditolak sebagai bukti kehadiran: biometrik platform hanya membuktikan "salah satu jari/wajah terdaftar di perangkat ini" bukan "karyawan X" pada iPad bersama **[V12]**. Dipakai opsional sebagai step-up manajer, bukan absensi. |
| D. PIN/QR di POS | Tetap tersedia sebagai metode `pin` dengan flag; jadi cadangan bila terminal rusak. Tanpa bukti biometrik, `needs_review` untuk persetujuan manajer. |

Alur: karyawan menempelkan jari → terminal mencocokkan → mengirim catatan kehadiran (kode person, waktu, tipe verifikasi) ke bridge → bridge menormalkan ke `{terminal_serial, person_code, ts, verify_type}`, menyimpan di antrean lokal bertahan, meneruskan dalam batch bertanda HMAC ke `POST /devices/punches` → server memetakan `person_code → user`, membuat `punch` (idempoten pada `(terminal_serial, person_code, ts)`), menerbitkan `clock_in`/`clock_out` ke notifikasi dan memperbarui status di POS lewat tarik. Kode person tak dikenal → `needs_review`. Enrol dilakukan fisik di terminal; Shelfline mengirim perintah tambah/hapus *pengguna* (nama + kode, tanpa template) bila model mendukung **[V09]**. Aspek hukum biometrik (persetujuan, retensi) perlu verifikasi **[V10]**.

### 5.6 Izin laporan (F24)
Setiap permintaan laporan melewati `ReportScope` yang dibuat server dari `report_grant` aktif (gabungan semua grant pengguna): `locations` (daftar), `date_range` (dipotong ke rentang yang diizinkan, termasuk rentang bergulir yang dievaluasi saat permintaan), `hidden_columns`. Repositori laporan **tidak menerima** filter lokasi/tanggal langsung dari klien tanpa melewati `ReportScope.clamp()`. Kolom tersembunyi dihapus di lapisan hasil dan agregat yang akan mengungkapkannya (mis. margin) juga ditolak. Tes: pengguna dengan grant Fitzroy 1–31 Okt tidak bisa melihat Fremantle, 1 Nov, atau kolom biaya dengan manipulasi parameter, UI portal, ekspor CSV, atau tautan unduhan.

### 5.7 Laporan akhir hari otomatis dan notifikasi (F25, F26)
- Hari bisnis per lokasi: `day_cutoff` (mis. 04:00) pada zona waktu lokasi; DST ditangani lewat pustaka zona (Perth tanpa DST, Melbourne dengan DST sebagai kasus uji).
- Jadwal → `scheduled_job` dengan kunci `(schedule_id, local_date)` dihitung dari `send_at_local`. Saat jalan: jika `only_when_closed` dan masih ada register terbuka → tunda & coba lagi sampai batas; jika ada perangkat dengan antrean sinkron belum kosong → kirim **versi sementara** (`provisional`) berlabel; setelah sinkron data baru masuk → kirim **versi koreksi** (`amended`) hanya jika angka berubah.
- Pengiriman lewat outbox: email (PDF/CSV) dan webhook di P2; WhatsApp/SMS hanya bila penyedia terverifikasi **[V14]**.
- Notifikasi: pemicu dari peristiwa domain dalam transaksi (outbox): `punch.in/out`, `register.opened/closed`, `cash.no_sale`, `session.variance_over`, `refund.over_limit`, `shift.late`. Aturan memfilter per lokasi/ambang; jam tenang dan ringkasan. "Laci dibuka tanpa penjualan" = perintah `no_sale` dari POS (tombol/izin) terjamin; **deteksi pembukaan laci fisik tanpa perintah** hanya jika printer/laci menyediakan status **[V08]**.

### 5.8 Harga dan pajak
`@shelfline/pricing` murni dan deterministik; urutan: price book (prioritas, berlaku-tanggal, lokasi) → promosi → diskon manual (butuh izin & alasan) → pajak (inklusif/eksklusif per kelas dan wilayah) → pembulatan tunai opsional per lokasi. Server menjalankan fungsi yang sama untuk validasi pasca-sinkron. Vektor uji emas (≥200 kasus) dibagi POS dan server. Tarif pajak contoh (GST 10% Australia) perlu verifikasi **[V15]**.

## 6. API / route (ringkas)

| Method · path | Peran | Fitur |
|---|---|---|
| `POST /auth/login`, `/auth/totp`; `POST /pos/pin` | publik/perangkat | F2 |
| `GET /sync/pull`, `POST /sync/push`, `GET /sync/status` | perangkat POS | F5, F12 |
| CRUD `/products`, `/variants`, `/categories`, `/tax` | HQ manager | F3 |
| `GET /inventory`, `GET /inventory/:variant/ledger`, `POST /inventory/adjust`, `POST /inventory/receive` | store/HQ manager | F4 |
| `GET /sales`, `/sales/:id`, `POST /sales/:id/refund` (online) | store manager, cashier (terbatas) | F9, F10 |
| `GET /registers`, `/sessions/:id`, `/sessions/:id/z-report` | store manager | F8, F11 |
| `/customers` | cashier, manager | F10 |
| `/punches` (POST dari POS), `POST /devices/punches` (dari bridge, HMAC) | POS, bridge | F13, F22 |
| `/suppliers`, `/purchase-orders`, `/receipts`, `/bills` | purchaser, finance | F14, F15 |
| `/transfers`, `/stock-counts` | HQ/store manager | F16, F17 |
| `/price-books`, `/promotions` | HQ manager | F18 |
| `/gift-cards`, `/store-credit` | cashier (redeem), manager | F19 |
| `/shifts`, `/timesheets`, `/terminals`, `POST /devices/pair` | roster, teknisi | F20–F22 |
| `/commission/rules`, `/commission/statements`, `POST /commission/periods/:id/lock` | owner, finance | F23 |
| `/reports/:key`, `/report-grants`, `/portal/*` | sesuai grant; owner | F24 |
| `/notification-rules`, `/eod-schedules` | owner, store manager | F25, F26 |
| `GET /stream` (SSE) | admin | F11 |
| Webhook masuk (P3): Shopify (`X-Shopify-Hmac-Sha256`, idempoten per `X-Shopify-Webhook-Id`), pembayaran storefront | sumber | F29, F30 |

Setiap endpoint tulis memeriksa izin dari matriks peran (dibaca ulang tiap request) dan lensa lokasi.

## 7. Integrasi pihak ketiga

| Layanan | Untuk | Batasan / biaya | Demo |
|---|---|---|---|
| Penyedia email (Resend atau SES) | Laporan akhir hari, undangan portal, notifikasi | Kuota dan harga: perlu verifikasi **[V14]** | Penyedia sandbox/penangkap lokal |
| WhatsApp Business / SMS | Notifikasi opsional | Templat, biaya per percakapan: perlu verifikasi **[V14]** | Dimatikan; bukan syarat |
| Stripe Terminal | Pembayaran kartu (P2) | JS SDK hanya internet reader; Bluetooth via SDK iOS; tak ada offline di JS SDK ([docs](https://docs.stripe.com/terminal/sdk/js)); ketersediaan per negara perlu verifikasi **[V11]** | Mode uji Stripe + pembaca simulasi |
| Printer struk (Epson ePOS-Print / Star WebPRNT) | Struk, tendang laci | HTTP perangkat vs halaman HTTPS (mixed content), sertifikat **[V07]** | Bridge meneruskan; ada printer virtual |
| Terminal absensi (ZKTeco-kompatibel) | Punch | Protokol push, model, firmware **[V09]** | Simulator terminal di repo |
| Shopify Admin API (P3) | Channel dua arah | Versi API stabil terbaru, kunci idempoten **[V21]** | Toko dev (jika scope disetujui) |
| Xero (P3) | Ekspor akuntansi | Tier/kuota **[V16]** | Demo Company |
| Groq `gpt-oss-120b` (opsional, P3) | Ringkasan harian/pertanyaan laporan | kunci milik sendiri | hanya bila dipakai |

## 8. Keamanan
- Auth sesuai §2; peran dibaca ulang tiap request; PIN Argon2id dengan penguncian setelah N kegagalan; PIN hanya bekerja pada perangkat terdaftar.
- Token terpisah per audiens (`admin`, `pos`, `portal`, `device`); portal tidak bisa memanggil rute admin.
- Rahasia terenkripsi AES-256-GCM (kunci koneksi, TOTP); kunci perangkat disimpan sebagai hash.
- Rate limit pada login/PIN/kode portal; webhook bertanda HMAC dengan jendela waktu.
- Audit log tak berubah untuk tindakan sensitif: override harga, diskon di atas batas, refund, adjust stok, no-sale, koreksi punch, ubah izin, lihat laporan lewat portal.
- Data pribadi: pelanggan (nama, email, telepon) dan karyawan; biometrik tidak disimpan. Retensi dan persetujuan **[V10]**.
- Isolasi organisasi: `org_id` di semua tabel + tes isolasi; RLS Postgres di P3 (F35).
- Rantai pasok: lockfile, audit paket, tanpa skrip postinstall tidak perlu; biner bridge ditandatangani (P2) dan pembaruan diverifikasi.

## 9. Strategi tes
- **Unit/properti:** `money` (alokasi tidak kehilangan sen), `pricing` (vektor emas dibagi POS/server), komisi (properti: jumlah komisi = dasar × tarif ± pembulatan; clawback menolkan earn).
- **Ledger:** 3× kirim penjualan sama → stok turun sekali; 50 penjualan paralel/stok 10; urutan SKU berlawanan tanpa deadlock; invarian transfer; `SUM(delta) = on_hand`.
- **Sinkron:** tes model dengan 10 klien acak (putus, ulang, urutan campur, duplikat, jam melenceng) → keadaan server akhir identik dengan eksekusi serial; tes kursor dengan transaksi tumpang tindih **[V17]**.
- **Izin laporan:** matriks (lokasi × tanggal × kolom × jalur: UI, CSV, tautan) harus bocor nol; mutasi (hilangkan clamp) harus menggagalkan tes.
- **E2E (Playwright):** jual → putus jaringan → jual → sambung → sinkron; buka/tutup register dengan selisih; refund; EOD sementara lalu koreksi; DST Melbourne.
- **Perangkat keras:** daftar uji manual per perangkat nyata (terminal, printer, laci, pemindai) dengan catatan hasil; klaim tidak masuk README sebelum diuji **[V05–V12]**.
- Milestone selesai bila tes miliknya lulus berturut-turut dan checklist verifikasi di MILESTONES terpenuhi.

## 10. Daftar klaim yang perlu verifikasi

| ID | Klaim | Cara verifikasi termurah |
|---|---|---|
| V01 | Penyimpanan PWA yang dipasang ke Home Screen iPad tidak dievik oleh aturan 7 hari Safari (laporan komunitas ada, dokumentasi Apple tidak ditemukan; [forum](https://developer.apple.com/forums/thread/710157), [WebKit bug](https://bugs.webkit.org/show_bug.cgi?id=232302)) | Pasang PWA di iPad nyata, isi IndexedDB, biarkan >7 hari tanpa dibuka, buka lagi |
| V02 | `navigator.storage.persist()` diberikan di Safari iPadOS untuk PWA terpasang | Panggil dan catat hasil di perangkat nyata |
| V03 | Web Push iPad hanya untuk PWA terpasang (iOS/iPadOS 16.4+) | Tes langganan push di iPad |
| V04 | Safari tidak punya Background Sync; sinkron hanya saat aplikasi aktif | Tes: tutup app dengan antrean, amati |
| V05 | Browser iOS tidak punya WebUSB/WebSerial/Web Bluetooth (pembaca USB/printer Bluetooth langsung dari PWA tidak mungkin) | Cek caniuse/WebKit + uji perangkat |
| V06 | Plugin SQLite Capacitor terawat dan cukup untuk beban POS | Spike 0,5 hari: 50k varian, tulis antrean, baca. **Status (M19):** adaptor `SqliteStore` lulus suite kontrak yang sama (di SQLite Node), proyek iOS terbangun untuk simulator; belum dijalankan di iPad (docs/HARDWARE-TESTS.md) |
| V07 | **Status (M19): jalur lewat bridge dibangun dan teruji dengan printer virtual; belum dengan printer nyata.** Cetak ke printer jaringan dari halaman HTTPS: port 8008/8043 Epson, mixed content, sertifikat swasta ([ringkasan WCPOS](https://docs.wcpos.com/templates/printer-setup)) | Uji dari Safari iPad ke printer; bila gagal, jalur lewat bridge |
| V08 | **Status (M19): tendang laci dibangun (perintah teruji), status laci belum.** Status laci terbuka tersedia dari printer/laci tertentu (untuk deteksi buka tanpa perintah) | Baca manual model printer; uji dengan laci bersensor |
| V09 | Protokol push terminal ZKTeco-kompatibel (`/iclock/cdata`, `/iclock/getrequest`, ATTLOG tab: PIN, waktu, status, verify). **Sumber (dicari 2026-11-04):** implementasi pihak ketiga ([tanemrahman/zkteco-adms](https://packagist.org/packages/tanemrahman/zkteco-adms), [BNet.ZKTecoADMS](https://www.nuget.org/packages/BNet.ZKTecoADMS), [catatan DeepWiki](https://deepwiki.com/saifulcoder/adms-server-ZKTeco/2.1-device-communication-system)) dan dokumen PUSH SDK ZKTeco yang hanya sebagian ([pengantar](https://tecnosinergia.zendesk.com/hc/es/article_attachments/4418453804187)): HTTP di atas TCP/IP, balasan `OK: n`, `getrequest` = polling perintah sekaligus detak. **Belum ada**: spesifikasi resmi lengkap, arti kode status/verify (dipakai yang lazim: status 0 masuk, 1 keluar; verify 1 sidik jari, 15 wajah), dan uji pada terminal nyata. Adaptor `apps/bridge/internal/adms` dibuat toleran: baris rusak dilewati, kode tak dikenal → arah dibalik server dan verify "other". | Dapatkan dokumen PUSH SDK resmi + satu terminal; rekam lalu lintas nyata, jadikan berkas uji, perbarui klaim ini |
| V10 | Persetujuan, retensi, dan batas hukum pemrosesan data biometrik di yurisdiksi pengguna | Tinjauan hukum; template tetap di terminal sebagai mitigasi |
| V11 | Stripe Terminal: pembaca yang didukung, ketersediaan negara, tanpa mode offline di SDK JS | Dokumen Stripe + akun uji. **Status (M19): penyedia server-driven ditulis dari dokumen dan diuji terhadap server tiruan; belum dijalankan terhadap Stripe.** |
| V12 | Biometrik platform (WebAuthn) pada iPad bersama tidak dapat diatribusikan ke karyawan tertentu | Uji: daftarkan passkey dua pengguna, buka dengan jari yang sama |
| V13 | Fitur dan tier pesaing (Lightspeed, Shopify) per wilayah | Cek halaman harga resmi sebelum klaim di materi |
| V14 | Kuota/harga email, WhatsApp, SMS dan aturan templat | Dokumen penyedia |
| V15 | Tarif pajak penjualan (GST 10% Australia untuk demo), aturan harga inklusif pajak | Sumber otoritas pajak setempat |
| V16 | Tier gratis/Demo Company Xero untuk ekspor | Cek ulang sebelum dipakai. **Status (M23): dibangun dan diuji terhadap Xero tiruan; belum terhadap organisasi nyata.** |
| V17 | Kursor tarik `(txid, seq)` dengan batas `pg_snapshot_xmin` aman atas transaksi tumpang tindih | **Diuji (lulus)**: `sync-api.test.ts` V17 dan V17b (dua koneksi pg), tes model 200 skenario. Risiko tersisa: transaksi panjang menahan horizon |
| V18 | Aturan upah/award tidak termasuk; angka timesheet bukan penggajian | Batas lingkup yang dinyatakan |
| V19 | Distribusi pembungkus Capacitor (TestFlight/Custom App/ABM) dan aturan App Store | Dokumen Apple saat P2. **Status (M19): hanya terbangun untuk simulator.** |
| V20 | Pemindai barcode Bluetooth bekerja sebagai papan ketik di Safari iPad | Uji model pemindai nyata. **Status (M19): pendeteksi rentetan ketikan dibangun dan diuji di Chrome; belum dengan pemindai nyata.** |
| V22 | OpenID Connect dengan penyedia nyata (Okta, Entra, Google, Keycloak): discovery, nama klaim, selisih jam | Coba satu penyedia nyata. **Status (M24): dibangun dan diuji terhadap penyedia tiruan; belum terhadap penyedia nyata.** |
| V09b | Dorongan JSON gaya ISAPI dari terminal absensi (Hikvision-style) | Uji model nyata. **Status (M24): dibangun dan diuji terhadap simulator; nama bidang dan kode dari catatan integrasi publik, belum terhadap terminal nyata.** |
| V21 | Shopify Admin API terkini untuk inventaris/pesanan (cek versi stabil terbaru) | Cek `publicApiVersions` **Status (M21): dibangun dan diuji terhadap Shopify tiruan; belum terhadap toko nyata.** |

## 11. Deploy & lingkungan
- Demo: API + Postgres di satu host kontainer; PWA POS, admin, portal sebagai static; **demo publik berjalan penuh dengan data sintetis berlabel** dan simulator terminal/printer; bridge tidak diperlukan untuk demo (simulator di server). Hosting konkret ditunda sampai paket siap (aturan roadmap); catatan alasan di README.
- Seed: organisasi fiktif "Kestrel Run Co." (retail sepatu lari), 4 toko + 1 DC, ±900 varian, 90 hari transaksi sintetis berlabel.
- Variabel lingkungan: DB URL, kunci enkripsi, JWT secret, penyedia email, kunci Stripe uji.
- Backup: dump Postgres harian, uji pemulihan dijadwalkan; `stock_movement` dan `audit_log` append-only.
- Port host lokal: gunakan port yang belum dipakai proyek lain (cek `lsof` dulu).
