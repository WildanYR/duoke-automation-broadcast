# Duoke Playwright automation

Node.js + Playwright automation untuk mengirim satu atau lebih template pesan ke setiap buyer yang ada di conversation list Duoke.

## Setup

```bash
npm install
npx playwright install chromium
```

Edit `config.toml`, terutama `[chat].messages`, lalu jalankan:

```bash
npm start
```

Browser berjalan dengan persistent profile `.duoke-profile`. Pada run pertama, jika sesi belum login, lakukan login manual di browser yang dibuka script. Script menunggu `.main_cont` dan `.conversation_list_container` sebelum lanjut.

## Cara traversal list

Script melakukan dua phase:

1. Scroll conversation list dari atas ke bawah dan membuat snapshot seluruh nama buyer.
2. Baru setelah snapshot selesai, buka setiap buyer dan kirim template.

Pemisahan ini disengaja karena mengirim pesan dapat mengubah urutan conversation list. Terminal "sudah habis" tidak ditentukan hanya dari satu kali menyentuh bottom. Script mensyaratkan list tetap berada di bottom, prompt `Chat loading` tidak visible, `scrollHeight` stabil, dan tidak ada buyer baru selama `bottom_stable_rounds` probe berturut-turut.

Saat phase pengiriman, script tidak mencari setiap buyer dari paling atas. Karena buyer yang baru dikirim naik ke urutan pertama, buyer berikutnya tetap kurang-lebih berada pada ordinal snapshot semula. Script memakai ordinal itu sebagai fast-seek: langsung lompat ke rasio scroll target, melakukan koreksi lokal beberapa viewport jika perlu, lalu hanya memakai full scan dari atas sebagai fallback bila terjadi reorder eksternal atau buyer baru masuk. Log `BUYER_FAST_SEEK ... direct_hit=true` menunjukkan target ditemukan langsung dari lompatan tersebut.

Scrollable element dicari secara runtime hanya di dalam `.conversation_list_container` berdasarkan `scrollHeight/clientHeight` + `overflow-y`. Ini menghindari ketergantungan pada class hash untuk wrapper scrollbar.

## Dedupe SQLite

Database default: `duoke-sent.sqlite`.

- `buyers`: buyer yang seluruh array pesan sudah selesai.
- `sent_messages`: checkpoint per buyer/per index template dengan status `pending` atau `confirmed`.

Buyer yang sudah ada di `buyers` tidak akan dikirim lagi pada run berikutnya. Jika proses berhenti setelah pesan pertama dari tiga template sudah terkonfirmasi, checkpoint pesan pertama tetap tersimpan; run berikutnya melanjutkan pesan kedua tanpa mengulang pesan pertama.

Tepat sebelum `click Send`, script membuat checkpoint `pending`. Setelah outgoing message terverifikasi, status diubah menjadi `confirmed`. Jika proses/browser mati di window ambigu setelah `pending` dibuat tetapi sebelum konfirmasi lokal selesai, rerun **tidak** akan otomatis mengirim ulang pesan tersebut. Script berhenti pada buyer itu dengan `UNRESOLVED_PENDING` dan lanjut ke buyer lain. Ini sengaja fail-closed untuk mencegah duplicate send.

Setelah mengecek chat secara manual, jika pesan yang berstatus `pending` ternyata memang belum pernah terkirim, record pending itu dapat dihapus dari SQLite lalu script dijalankan ulang. Contoh inspeksi:

```sql
SELECT buyer_name, message_index, status, claimed_at, confirmed_at
FROM sent_messages
WHERE status = 'pending';
```

Karena dedupe final berbasis nama buyer sesuai requirement, perubahan template di kemudian hari tidak otomatis mengirim campaign baru kepada buyer yang sudah complete. Untuk campaign baru gunakan database SQLite baru atau hapus record secara sengaja.

## Selector durable yang dipakai

```text
.conversation_list_container
.conversation_list_container div[role="listitem"]:has(.buyer_name)
.buyer_name                         (scoped di row)
.conversation_list_container .infinite-status-prompt
.conversation_list_container .dk_empty
.cont_header .buyer_name
.cont_body .message_main
.cont_body .message_main > li
.cont_body .message_main > li.rt
.cont_body .message_main .infinite-status-prompt
.cont_footer textarea[maxlength="600"]
.cont_footer button:has(i.icon_send_chatbox)
```

Composer lebih dulu dicari dengan placeholder `Press / to trigger quick reply`, lalu fallback ke textarea scoped di `.cont_footer`.

Script sengaja tidak memakai `data-v-*`, `el-popover-*`, runtime ID, generic `[class*="loading"]`, atau keberadaan `.infinite-loading-container` sebagai state loading.

## State guards penting

- Page ready: `.main_cont` + `.conversation_list_container` visible.
- List loading: visible `.infinite-status-prompt` berisi `Chat loading`.
- List ready: ada row, atau visible empty-state yang scoped di list.
- Chat target: `.cont_header .buyer_name` harus sama persis dengan buyer sebelum fill dan diperiksa lagi tepat sebelum click Send.
- History: membedakan `Loading...`, `Loading Failed`, data, legitimate empty marker, dan transient empty gap.
- Composer ready: textarea + send button visible dan enabled.
- Send confirmed: outgoing `<li.rt>` bertambah dan salah satu outgoing terbaru mengandung isi template yang baru dikirim.

Jika satu buyer gagal, script mencatat error dan lanjut ke buyer berikutnya. Buyer yang gagal tidak ditandai complete, sedangkan message yang sudah terkonfirmasi tetap memiliki checkpoint.
