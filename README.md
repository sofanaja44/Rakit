# Rakit CLI

Rakit adalah CLI coding assistant sederhana untuk terminal. Saat ini mendukung OpenRouter API key, OpenAI Codex OAuth untuk akun ChatGPT Plus/Pro, Anthropic, Gemini, Groq, dan Ollama lokal.


## Fitur

- Chat langsung dari terminal
- Mode chat interaktif
- Output CLI berwarna dengan pembatas antar bagian
- Footer pinned sepanjang sesi untuk path, token, context, dan cost
- Streaming respons
- Baca/tulis/edit/hapus file dari CLI
- Aksi file ringkas: pilih Accept/Detail-Diff/Reject dengan panah lalu Enter
- Syntax highlighting untuk kode/diff di terminal
- Patch edit agar perubahan file tidak perlu rewrite penuh
- Konteks file otomatis dari prompt, `/read`, `/tree`, `/find`, dan `/inspect`
- Command approval untuk menjalankan shell command
- Session project: save, resume, dan new
- Config API key, model, dan theme
- Login API key atau OAuth
- Cari dan pilih model OpenRouter, termasuk filter model gratis
- Provider: OpenRouter, OpenAI Codex, Anthropic, Gemini, Groq, dan Ollama
- Command `doctor` untuk cek config, provider, dan terminal
- Siap build dan publish ke npm

## Kebutuhan

- Node.js 18 atau lebih baru
- Akun/API key OpenRouter, atau akun ChatGPT Plus/Pro untuk OpenAI Codex

## Install setelah publish

```bash
npm install -g rakit-cli
rakit --help
```

## Install lokal untuk development

```bash
npm install
npm run build
npm link
```

Setelah `npm link`, command `rakit` bisa dipakai secara global di komputer lokal.

## Konfigurasi

Cara paling mudah untuk login provider:

```bash
rakit login
```

Pilihan login:

- `1. OpenRouter API Key`: paste API key OpenRouter.
- `2. OpenAI Codex / ChatGPT Plus-Pro`: login lewat browser tanpa paste API key.
- `3. Anthropic API Key`: paste API key Anthropic.
- `4. Gemini API Key`: paste API key Gemini.
- `5. Groq API Key`: paste API key Groq.
- `6. Ollama Local`: pakai server Ollama lokal tanpa API key.

Setelah login, Rakit bisa membantu memilih model provider aktif.

Di mode chat interaktif juga bisa pakai:

```txt
/login
```

Cara manual set API key OpenRouter:

```bash
rakit config set apiKey sk-or-xxxx
```

Atau pakai environment variable (nilai env akan override apiKey config hanya untuk proses itu):

```bash
OPENROUTER_API_KEY=sk-or-xxxx rakit "halo"
ANTHROPIC_API_KEY=sk-ant-xxxx rakit "halo"
GEMINI_API_KEY=xxxx rakit "halo"
GROQ_API_KEY=gsk_xxxx rakit "halo"
OLLAMA_BASE_URL=http://localhost:11434/v1 rakit "halo"
```

Environment variable opsional untuk optimasi:

```bash
RAKIT_MAX_HISTORY_MESSAGES=40       # jumlah pesan history chat yang dikirim ke model; 0 = tanpa batas
RAKIT_MODELS_CACHE_TTL_MS=21600000  # cache daftar model OpenRouter 6 jam; 0 = nonaktif
```

Cari model berdasarkan provider aktif:

```bash
rakit models
```

Cari model gratis:

```bash
rakit models --free
```

Cari model gratis dengan kata kunci:

```bash
rakit models --free llama
```

Pilih model lewat wizard panah dan simpan ke config:

```bash
rakit models --select
```

Wizard langsung membuka menu model tanpa wajib mengetik search dulu. Gunakan tombol panah untuk cari/filter, toggle gratis/semua, skip, atau memilih model; model yang sedang aktif ditandai `(aktif)`.

Pilih model Codex setelah login OpenAI Codex:

```bash
rakit models --select codex
```

Atau set model manual:

```bash
rakit config set model meta-llama/llama-3.1-8b-instruct:free
rakit config set model gpt-5.1-codex-mini
```

Pilih theme UI:

```bash
rakit config set theme rich       # default, footer lengkap
rakit config set theme compact    # footer lebih pendek
rakit config set theme minimal    # footer paling ringkas
rakit config set theme no-footer  # tanpa footer pinned
```

Lihat config aktif:

```bash
rakit config get
```

Lihat lokasi config:

```bash
rakit config path
```

Default config disimpan di:

```txt
~/.rakit/config.json
```

Token OAuth OpenAI Codex disimpan di:

```txt
~/.rakit/auth.json
```

## Penggunaan

Prompt langsung:

```bash
rakit "buatkan contoh fungsi login express"
```

Mode chat interaktif:

```bash
rakit
```

Atau:

```bash
rakit chat
```

Mode TUI layar penuh:

```bash
rakit tui
```

Mode ini masuk ke alternate screen sehingga terminal biasa tersembunyi selama sesi, dengan header, area chat, dan footer status Rakit.

Cek environment/config:

```bash
rakit doctor
```

Perintah dalam mode chat:

```txt
/help   Tampilkan bantuan
/login  Login provider lewat wizard
/models Cari dan pilih model provider aktif
/model  Tampilkan provider dan model aktif
/files  Tampilkan bantuan perintah file
/pwd    Tampilkan folder kerja
/ls     Lihat isi folder. Contoh: /ls src
/tree   Lihat tree project. Contoh: /tree src
/inspect Analisis tree + file penting. Contoh: /inspect Desktop/login-page
/find   Cari path/isi file. Contoh: /find login
/read   Baca file. Contoh: /read package.json
/write  Tulis/overwrite file. Contoh: /write index.html
/append Tambah isi file. Contoh: /append notes.txt
/edit   Edit file dengan overwrite. Contoh: /edit src/app.js
/mkdir  Buat folder. Contoh: /mkdir src/components
/delete Hapus file/folder. Contoh: /delete old.js
/run    Jalankan command setelah konfirmasi. Contoh: /run npm test
/session Info session project
/resume Load session project terakhir
/save   Simpan session sekarang
/new    Session baru dan hapus session tersimpan
/clear  Hapus history sesi ini
/exit   Keluar
```

## Daftar dan pencarian model

`rakit models` menampilkan model dari provider aktif.

- OpenRouter: daftar model diambil langsung dari OpenRouter memakai API key aktif.
- OpenAI Codex: daftar model Codex yang dikenal Rakit ditampilkan dan memakai kuota subscription ChatGPT.

Contoh:

```bash
rakit models --free qwen
rakit models --free gemini
rakit models llama --limit 10
rakit models --select --free
rakit models --select codex
```

Di mode chat interaktif, ketik `/models` untuk langsung membuka picker panah, atau `/models llama` dan `/models codex` untuk membuka picker dengan filter awal.

## Membuat dan mengubah project

Jalankan Rakit dari folder project:

```bash
rakit
```

Contoh prompt:

```txt
buatkan project todo app html css js, simpan sebagai index.html style.css app.js
```

Saat AI menulis jawaban/kode, output ditampilkan live dengan syntax highlighting. Tag internal aksi file disembunyikan dari layar. Output `/read`, `/tree`, `/find`, `/inspect`, dan konteks file relevan dari prompt otomatis masuk ke chat, jadi tidak perlu paste ulang. Saat ada aksi file atau command, pilih `Accept`, `Detail/Diff`, atau `Reject` dengan tombol panah lalu Enter. Command shell dan delete tetap perlu approval eksplisit.

Perintah manual file:

```txt
/ls
/read index.html
/write index.html
/edit src/app.js
/delete old.js
/run npm test
```

Catatan keamanan: aksi file dan command selalu memakai approval user. Path/cwd harus relatif di dalam folder kerja saat ini.

## Build

```bash
npm run build
npm run validate
```

## Publish ke npm

Pastikan sudah login npm:

```bash
npm login
```

Publish:

```bash
npm publish
```

Jika ingin menggunakan scope npm pribadi, ubah `name` di `package.json`, misalnya:

```json
{
  "name": "@username/rakit"
}
```

Lalu publish scoped public package:

```bash
npm publish --access public
```

## Version plan

Lihat detail perubahan di [CHANGELOG.md](CHANGELOG.md).

### v0.1.x — Stabilization

- `v0.1.1`: changelog, roadmap versi, doctor provider readiness, dan test config tambahan.
- `v0.1.2`: test provider switching/session lebih lengkap dan smoke test CLI dasar.
- `v0.1.3`: command approval polish, timeout command configurable, dan limit output command configurable.

### v0.2.x — UX & safety

- Command execution lebih aman: output streaming, truncation lebih jelas, dan allowlist opsional.
- Diff preview v2: grouped hunks, summary per file, dan preview delete/write/patch lebih rapi.
- TUI polish untuk output panjang, status loading, dan footer/input yang lebih stabil.
- Session UX: list/delete session project dan metadata session yang lebih jelas.

### v0.3.x — Provider & model intelligence

- Metadata/capability model yang lebih kaya untuk Anthropic, Gemini, Groq, dan Ollama.
- Doctor provider-specific untuk API key/env/base URL/model aktif.
- Model picker v2 dengan filter capability/context/cost/free dan sorting recommended/coding/fast/local.
- Error provider yang lebih actionable dan usage/cost yang lebih konsisten.

### v0.4.x — Agent mode

- Agent loop terkontrol: plan → inspect → edit → test → summarize.
- Task list internal untuk pekerjaan multi-step.
- Auto-run test setelah apply perubahan dengan approval user.
- Project context yang lebih pintar berdasarkan framework/dependency.

### v1.0.0 — Stable public release

- Config/session/provider behavior stabil dan tested.
- File safety dan command approval matang.
- TUI dan non-TUI sama-sama nyaman dipakai.
- Dokumentasi install, login, provider, model, session, file action, dan troubleshooting lengkap.
- Metadata publish final: package name, bin alias, author, repository, bugs, homepage, license, dan git release tags.

## License

MIT
