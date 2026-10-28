# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Đa Khoa Đức Minh" — a real, deployed clinic management web app (Node.js/Express + PostgreSQL), live at
https://duc-minh-clinic.onrender.com. It is a monolith: Express serves both the JSON API (`/api/*`) and
the static frontend (`public/*.html` + plain `<script>` files — no build step, no frontend framework,
no bundler). All UI text, comments, and commit messages in this repo are in Vietnamese.

Four roles: `admin`, `staff`, `doctor`, `patient` (see `ROLES` in `src/db.js`). Most routes branch behavior
per role rather than having separate route trees.

## Commands

```
npm install
npm run dev      # same as `npm start` — node src/server.js, no watch/reload
npm start
```

- No automated test suite (`npm test` is a stub that exits 1). There is no test runner configured in this
  repo — when asked to add tests, ask which tool to introduce rather than assuming one.
- No lint/format tooling configured (no ESLint/Prettier config present).
- Requires `DATABASE_URL` (Postgres) and `JWT_SECRET` env vars to boot at all; see `.env.example` for every
  other optional var (`GEMINI_API_KEY`, `REQUIRE_OTP`, `SMTP_*`, `ADMIN_REGISTER_CODE`). Missing `GEMINI_API_KEY`
  or unset `SMTP_*`/`REQUIRE_OTP` are meant to degrade gracefully (AI features report "not configured", OTP
  codes get logged to the console instead of emailed) — not startup errors.
- One-off maintenance scripts (run manually, not part of any npm script):
  - `node scripts/ingest-chuyen-khoa.js` — chunks + embeds the MSD manual PDFs from the sibling directory
    `../Chuyên khoa` (one level above this repo, i.e. `D:\AI\Chuyên khoa`) into the `kb_documents`/`kb_chunks`
    RAG tables. Safe to re-run: skips documents whose title already exists.
  - `node scripts/seed-doctor-bios.js` — one-time data seed.

## Architecture

### No migration tool — schema lives in code

`src/db.js`'s `init()` runs on every server boot: `CREATE TABLE IF NOT EXISTS` for each table, followed by a
long tail of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` pairs
for anything added after the initial table. This *is* the migration history — when adding a column or
constraint, follow the same idempotent pattern in `init()` rather than writing a separate migration file.
Changing an enum-like `CHECK` constraint (e.g. `SPECIALTIES` in `src/constants.js`) means updating the
constraint in `db.js` to match.

One deliberate non-fix documented inline: `kb_chunks.embedding` is `vector(3072)` (Gemini
`gemini-embedding-001`), which exceeds pgvector's 2000-dimension limit for HNSW/IVFFlat indexes — creating
such an index crashes the server on boot (this actually happened once). The table intentionally has **no**
ANN index; similarity search is a sequential scan, which is fine at this clinic's document scale. Don't
"optimize" this by adding an index back.

### Auth & authorization

`src/middleware/auth.js`: JWT payload carries `{ id, email, role, name }`. `authenticate` re-checks
`is_active` from the DB on *every* request (not just JWT signature/expiry) so that admin-locking an account
invalidates any outstanding 7-day JWT immediately — don't "optimize" this into trusting the JWT payload alone.
`optionalAuthenticate` (used by the public chat endpoint) sets `req.user = null` on any failure instead of
rejecting. `requireAdmin` / `requireRole(...roles)` gate individual routes.

### Route/lib split

`src/routes/*.js` are thin Express handlers; shared business logic that must behave identically across
multiple entry points lives in `src/lib/`. The clearest example: `src/lib/appointmentService.js`
(`createAppointment`/`updateAppointment`/validation) is called both by `POST /api/appointments` (the web
form) and by the AI's `book_appointment` tool in `src/routes/ai.js` — this is intentional so booking rules
(slot format, Sunday-booking deadline, phone/age validation, doctor-shift checks) never drift between the two
entry points. When changing booking validation, change it once in `appointmentService.js`.

Similarly `src/lib/availability.js` (`getAvailableSlots`, `FIXED_SLOTS` = every 30 min, 07:00–20:30) is the
single source of truth for open slots, used by both the booking calendar and the AI's `check_available_slots`
tool. Appointments booked without a specific doctor (`doctor_id` NULL) still consume one doctor of that
specialty at that time: a slot is open only while free doctors > unassigned appointments. The DB unique index
only covers assigned appointments, so `createAppointment`/`updateAppointment` re-check with `isSlotOpen()`
before writing — keep that check when touching booking.

URL ids (`:id`, `:appointmentId`) are validated by `router.param(..., intParam)` (`src/middleware/params.js`) on
every router — a non-numeric id returns 404 instead of a Postgres type error 500. Register it on new routers too.

Frontend rule: any user- or AI-supplied text interpolated into `innerHTML` must go through the page's `esc()`
(patient names are self-chosen at registration and render on staff/admin pages — stored XSS otherwise). AI replies
use `setChatText()` from `chat-format.js`.

### Billing & discounts

- `service_prices` (one row per specialty) holds the consultation fee; a specialty with no row means "price
  not set yet" (distinct from a 0đ/free price) and blocks invoice creation with an explicit error.
- `discount_rates` holds a `%` per category (`bhyt`, `sinh_vien`). An appointment stores at most one
  `discount_category` (chosen at booking time by the patient; staff verify the physical card at invoice
  time) — discounts never stack.
- Invoice generation (`POST /api/billing/invoices`, in `src/routes/billing.js`) only fires for appointments
  with `status = 'hoan_thanh'`, and only discounts the consultation-fee line item (never medicines). The
  discount is stored as its own negative `invoice_items` row, not folded into the fee, so the % actually
  applied is reconstructible later even if `discount_rates` changes afterward (see `attachInvoiceItems` in
  `billing.js`, which recomputes `discountPercent` from the stored line items rather than re-reading
  `discount_rates`).
- `public/invoice-sheet.js` is the single source of the "Phiếu thu" (receipt) markup, shared by the print
  page (`in.html?type=hd`) and the in-page "view details" modal on `hoa-don.html`/`ho-so.html` — keep both
  call sites using this module rather than duplicating the HTML.

### AI: two separate assistants, don't conflate them

- **`POST /api/ai/chat`** (`src/routes/ai.js`) — the public homepage chatbot, `optionalAuthenticate`. Has a
  RAG pipeline (Multi-Query + HyDE query expansion, `retrieveKnowledgeExpanded`) plus two universal tools
  (`check_available_slots`, `book_appointment`). When the caller is a logged-in `patient`, it *also* gets
  `assistantTools`'s `my_appointments`/`my_records`/`my_invoices`/`my_followups` tools (see `PATIENT_TOOL_NAMES`
  in `ai.js`) — this replaced a separate chat widget that used to live in the patient workspace.
- **`POST /api/ai/assistant`** — the role-scoped assistant inside `khong-gian.html` (the "workspace"). Tools
  are declared per-role in `src/lib/assistantTools.js` (`toolsForRole`) and enforce their own row-level
  scoping in code (e.g. `appointments_by_date` filters to `doctor_id = $1` when the caller is a doctor) —
  never rely on the system prompt alone to restrict what a role can see.
- Both endpoints persist history to `chat_conversations`/`chat_messages` (only for logged-in users), keyed by
  a `channel` column (`'main'` vs `'assistant'`) so the two histories don't mix. A conversation can only be
  resumed by its owner on the matching channel — always re-check `user_id` (and `channel`) before trusting a
  client-supplied `conversationId`.
- Gemini's free tier is quota-limited (20 requests/day/model) and this has caused real outages — see
  `src/lib/chatAnalysis.js`: before calling Gemini, deterministic regex logic extracts/validates phone
  numbers, age, dates, and times from the raw message and feeds the *verified* facts into the system prompt.
  This exists because the model was unreliable at things like counting phone-number digits or merging a phone
  number with an adjacent age (e.g. "0353102966 25 tuổi" mis-parsed as one 12-digit number) — prefer fixing
  bugs like that in `chatAnalysis.js`'s deterministic parsing over re-prompting the model. Also: messages with
  no letters/digits, or that are pure numbers, skip the query-expansion Gemini call entirely to save quota.
- `/api/ai/chat` is layered, the model is the LAST resort (built over 5 probing rounds, ~600 questions, against
  `qwen3:1.7b`): (1) `normalizeMessage` fixes repeated letters, teencode and missing diacritics; (2) `chatAnalysis.js`
  detectors — specialty (child/pregnancy beats symptoms, `Nội tổng quát` loses ties), emergency, crisis, slot
  query + dates, price/discount, dose, antibiotics, own-data, privacy/prompt-injection, off-topic, identity…;
  (3) fixed code replies for anything with a deterministic answer (crisis and privacy refusals in ALL modes, the rest
  only with `COMPACT_PROMPT`, default on for Ollama); (4) `chat_examples` few-shot bank (`src/lib/chatExamples.js`,
  admin UI on `/co-so-tri-thuc.html`, seed `scripts/seed-chat-examples.js`) — Gemini vectors, falling back to
  trigram matching when the free embedding quota (1000/day, really exhausted during testing) runs out;
  (5) compact prompt + a post-filter on the model's reply. Rules learned the hard way: never put quoted phrases in
  the compact prompt (the 1.7B model copies them verbatim — it replied "Bạn là ai?" to "ok"); every detector regex
  needs negative cases ("5/11" is a date, not division; "đánh trống ngực" is not a slot question; "bệnh nhân" is not
  a complaint). Every bug found becomes a case in `npm run eval-chat` (`scripts/eval-chatbot.js`, 86 cases, mostly
  phrased differently from the seeded examples) — keep it at 100% across repeated runs.
- All LLM calls go through `src/lib/llm.js` (`chatWithTools`, `generateJSON`, `generateText`), which picks the
  provider from `AI_PROVIDER`: `gemini` (default, what production on Render uses) or `ollama` (a local model,
  default `qwen3:4b-instruct` — not `qwen3:4b`, which is the always-thinking Thinking-2507 variant and takes 20-60s per reply;
  the dev laptop uses `qwen3:1.7b` since its 4 GB GPU can't hold the 4B fully). Don't call the Gemini
  SDK directly from routes. Ollama errors fall back to Gemini (`withFallback`) when `GEMINI_API_KEY` is set — except
  after a tool already ran in that turn (`e.toolsRan`), since replaying tools on Gemini could double-book.
- Render reaches the laptop's Ollama via `npm run tunnel` (`scripts/ollama-tunnel.js`): an auth proxy (only
  `POST /api/chat` with `Bearer OLLAMA_API_KEY`) behind a Cloudflare quick tunnel, whose changing URL the script
  re-registers every 2 min at `POST /api/ai/ollama-endpoint` (same key). The registered URL is in-memory and expires
  after 5 min without a heartbeat (`REMOTE_OLLAMA_TTL_MS`), then `OLLAMA_HOST` is used again. Never relax the key check
  on that endpoint — whoever can register a URL receives every patient's chat. Embeddings (`src/lib/embeddings.js`) always stay on Gemini regardless of
  `AI_PROVIDER` — `kb_chunks` holds 3072-dim `gemini-embedding-001` vectors, so switching embedding models
  means re-embedding the whole knowledge base. With Ollama, Qwen3's thinking mode is off (`OLLAMA_THINK`),
  `num_ctx` is raised to 8192 (the default 4096 silently truncates the long chat system prompt), and the
  Multi-Query/HyDE expansion call is off by default (`AI_QUERY_EXPANSION`) since it runs serially before the
  answer and roughly doubles local latency.
- `withRetry()` in `llm.js` retries 503/429 but *not* daily quota exhaustion (`RESOURCE_EXHAUSTED`/`PerDay`) —
  that's reported to the user immediately as "hết hạn ngạch hôm nay", since retrying is pointless until the
  next day.

### Timezone

The clinic operates in `Asia/Ho_Chi_Minh`. SQL queries that need "today" or day-boundaries use
`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` (see `TODAY_VN` constants in `followups.js`, `stats.js`
helpers); JS-side "today" uses `new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })`
(gives `YYYY-MM-DD` directly). Follow this pattern for any new date-sensitive logic instead of using the
server's local time or naive UTC.

### Audit logging

`src/lib/audit.js`'s `logAudit(user, action, entity, entityId, detail)` is fire-and-forget: it swallows its
own errors so a broken audit insert never breaks the calling request. `ACTION_LABELS` in the same file is the
canonical list of action types shown in the admin "Nhật ký hoạt động" — add new actions there when logging a
new kind of event. Patient self-views of their own records/invoices are logged too (`record.self_view`,
`invoice.self_view`), including when triggered indirectly through the AI chat tools (tagged `via: 'ai_chat'`
in the detail).

### Frontend pages (`public/`)

Every page is a standalone `.html` with inline `<script>` (vanilla JS, `fetch` against `/api/*`, no
framework). Small cross-page behaviors are factored into standalone scripts loaded via `<script src>` rather
than a bundler: `account-menu.js` (top-nav user menu + role switcher), `float-contact.js` (floating
Chat/Zalo buttons, hidden for staff-like roles), `invoice-sheet.js` (see Billing above), `chat-format.js`
(`setChatText(el, text)` — renders AI replies in both chat boxes: escapes HTML first, then turns `**bold**`,
`### heading`, `* ` bullets into markup; use it for bot messages instead of `textContent`). `in.html` is the
generic print view for both `type=dt` (prescription) and `type=hd` (invoice), fetching the same JSON the
in-page views use.
