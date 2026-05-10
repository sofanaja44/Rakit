# Changelog

Semua perubahan penting Rakit CLI dicatat di file ini.

Format mengikuti pola sederhana: `Unreleased` untuk pekerjaan berikutnya, lalu release versi stabil.

## Unreleased

- Belum ada perubahan.

## v0.1.3

Patch stabilisasi untuk doctor dan config UX.

### Added

- Hint setup provider aktif yang lebih spesifik di `rakit doctor`.
- Command `rakit config list` sebagai alias dari `rakit config get`.

### Changed

- Help `rakit config set` dibuat lebih jelas dengan contoh provider valid.

## v0.1.2

Patch stabilisasi untuk session persistence dan executable CLI.

### Added

- Test lifecycle session project untuk save, load, summary, dan clear.
- Smoke test CLI untuk `--version`, `--help`, `about`, dan `doctor`.

## v0.1.1

Patch stabilisasi untuk release hygiene dan version safety.

### Added

- Version plan di README untuk roadmap v0.1.x sampai v1.0.0.
- `CHANGELOG.md` sebagai catatan perubahan resmi.
- Script `npm run version:check` untuk memastikan versi package, lockfile, dan CLI sinkron.
- Doctor provider readiness yang lebih detail untuk semua provider.
- Test coverage tambahan untuk default model semua provider dan redaction API key.

### Changed

- `npm run validate` sekarang menjalankan version check sebelum typecheck, test, dan audit.

## v0.1.0

Baseline awal Rakit CLI.

### Added

- CLI `rakit` untuk prompt langsung, chat interaktif, dan mode TUI.
- Provider OpenRouter, OpenAI Codex, Anthropic, Gemini, Groq, dan Ollama.
- Login API key/OAuth dan konfigurasi provider/model/theme.
- Streaming respons dan footer status token/context/cost.
- File actions untuk write, patch, delete, mkdir, dan command dengan approval.
- Project context dari `/read`, `/tree`, `/find`, `/inspect`, dan auto context prompt.
- Session project untuk save, resume, new, dan clear.
- Model listing dan model picker berbasis panah.
- Command `doctor` untuk cek environment dasar.
- Test dasar untuk config/session, file actions, SSE parser, dan UI helper.
