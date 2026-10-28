# Đa Khoa Đức Minh — Website + hệ thống quản lý phòng khám

Một web Node.js/Express thật, đã triển khai công khai tại **https://duc-minh-clinic.onrender.com**, gồm:

- **Trang chủ** (`/`) — landing page giới thiệu phòng khám, có khung chat AI (câu trả lời hiển thị chữ đậm/gạch đầu dòng qua `public/chat-format.js`, dùng chung với trợ lý trong Không gian làm việc).
- **Tài khoản** (`/tai-khoan.html`) — đăng ký/đăng nhập bằng Email hoặc SĐT + mật khẩu, 4 vai trò: Bệnh nhân, Bác sĩ, Nhân viên, Quản trị viên. Có sẵn xác thực OTP qua email (2FA) nhưng đang tắt mặc định — xem Bước 5.5.
- **Đặt lịch khám** (`/dat-lich.html`) — bệnh nhân chọn chuyên khoa/bác sĩ/giờ, xem lịch của mình. Lịch "không chọn bác sĩ cụ thể" vẫn tính là chiếm 1 bác sĩ của chuyên khoa ở giờ đó, nên một khung giờ chỉ còn trống khi số bác sĩ rảnh nhiều hơn số lịch chưa gắn bác sĩ (không thể đặt quá số bác sĩ, kể cả qua trợ lý AI).
- **Hàng đợi khám** (`/hang-doi.html`) — nhân viên/bác sĩ/admin xem và cập nhật trạng thái lịch hẹn.
- **Khám bệnh** (`/kham-benh.html`) — bác sĩ ghi chẩn đoán, kê đơn thuốc, có cảnh báo tương tác thuốc kèm gợi ý thuốc thay thế cùng nhóm, và tóm tắt AI bệnh sử.
- **Hồ sơ khám bệnh** (`/ho-so.html`) — bệnh nhân xem lại lịch sử khám + đơn thuốc + hoá đơn, tự thanh toán hoá đơn chưa trả bằng mã QR chuyển khoản (VietQR). Mã QR chỉ hiện khi admin đã nhập tài khoản nhận tiền ở trang Danh mục thuốc; chưa nhập thì trang báo bệnh nhân thanh toán tại quầy. Sau khi bấm "Tôi đã chuyển khoản", trang hiện "Vui lòng giữ máy, chờ xác nhận" và tự kiểm tra lại (không tải lại trang): 3 lần đầu cách nhau 5 giây, sau đó 30 giây/lần, dừng hẳn sau khoảng 10 phút. Khi nhân viên xác nhận đã nhận tiền thì báo "Chuyển khoản thành công" và dừng kiểm tra (kể cả khi hoá đơn đã được thu trước lúc bấm); đến lần 3 (giây 15) vẫn chưa có tiền thì yêu cầu gọi nhân viên hỗ trợ qua hotline nhưng vẫn tự kiểm tra tiếp để báo thành công khi được xác nhận; có nút "Kiểm tra lại ngay".
- **Danh mục thuốc** (`/danh-muc-thuoc.html`) — admin quản lý thuốc (kèm nhóm thuốc/hoạt chất để hệ thống gợi ý thay thế), giá thuốc, quy tắc tương tác, giá khám theo chuyên khoa, và thông tin tài khoản nhận thanh toán QR.
- **Hoá đơn** (`/hoa-don.html`) — nhân viên/admin lập hoá đơn và xác nhận thu tiền; được nhắc khi bệnh nhân đã báo chuyển khoản qua QR để ưu tiên đối chiếu.
- **Lịch trực bác sĩ** (`/lich-truc.html`) — admin phân công ca trực/lịch làm việc theo tuần cho từng bác sĩ; trang đặt lịch chỉ mở đúng khung giờ đã phân công (bác sĩ chưa cấu hình thì mặc định làm việc cả ngày như cũ).
- **Không gian làm việc** (`/khong-gian.html`) — ngoài biểu đồ doanh thu/lượt khám, admin xuất được báo cáo ra file Excel (.xlsx) thật hoặc in/lưu PDF; admin cũng khoá/mở khoá được tài khoản (tách biệt với đổi vai trò RBAC), và nhật ký hoạt động ghi lại cả các lượt đăng nhập thành công/thất bại.

CSDL **PostgreSQL thật** (Neon, miễn phí) — không mất dữ liệu khi deploy công khai và server khởi động lại.

---

## Bước 1 — Tạo CSDL PostgreSQL miễn phí (5 phút, không cần cài gì)

1. Vào https://neon.tech, đăng ký tài khoản miễn phí (đăng nhập bằng GitHub/Google là nhanh nhất).
2. Tạo 1 project mới (Neon tự tạo sẵn 1 database).
3. Vào phần **Connection string**, copy chuỗi dạng:
   `postgresql://<user>:<password>@<host>/<db>?sslmode=require`
4. Dán chuỗi đó vào `DATABASE_URL=` trong file `.env` (ở máy bạn, để test trước khi deploy).

## Bước 2 — Chạy thử ở máy bạn

```
cd duc-minh-backend
npm install
npm run dev
```

Mở http://localhost:4000 → thấy trang chủ. Bấm "Đăng nhập" → sang `/tai-khoan.html` → thử đăng ký/đăng nhập.

> Mình đã sửa toàn bộ code sang PostgreSQL nhưng **chưa tự chạy thử được với CSDL thật** trong môi trường này (máy không có sẵn Postgres/Docker để test). Sau khi bạn có `DATABASE_URL` ở bước 1, hãy tự chạy `npm run dev` và thử đăng ký/đăng nhập/xem danh sách admin một lượt trước khi deploy công khai — nếu có lỗi gì cứ gửi lại mình sửa tiếp.

## Bước 3 — Đưa code lên GitHub

Máy bạn hiện **chưa cài Git** (mình thử cài giúp nhưng bị chặn vì cần quyền admin). Bạn cài Git theo 1 trong 2 cách:
- Tải https://git-scm.com/download/win, cài đặt bình thường (Next → Next → Install), hoặc
- Cài GitHub Desktop (https://desktop.github.com) — có giao diện, không cần dùng dòng lệnh.

Sau khi có Git, tạo 1 repo mới trên GitHub (đặt tên ví dụ `duc-minh-clinic`), rồi ở thư mục `duc-minh-backend`:

```
git init
git add .
git commit -m "Website va tai khoan Da Khoa Duc Minh"
git branch -M main
git remote add origin https://github.com/<ten-github-cua-ban>/duc-minh-clinic.git
git push -u origin main
```

(File `.env` đã được `.gitignore` — mật khẩu/secret của bạn sẽ không bị đẩy lên GitHub.)

## Bước 4 — Deploy lên Render (miễn phí, có link công khai)

1. Vào https://render.com, đăng ký (dùng GitHub cho nhanh).
2. **New +** → **Web Service** → chọn repo `duc-minh-clinic` vừa tạo. Render sẽ tự đọc file `render.yaml` mình đã chuẩn bị sẵn trong repo (build command, start command đã điền sẵn).
3. Điền 2 biến môi trường còn thiếu trong phần Environment:
   - `DATABASE_URL` = chuỗi kết nối Neon ở Bước 1.
   - `ADMIN_REGISTER_CODE` = một mã bí mật do nhóm tự đặt (ví dụ `DUCMINH-ADMIN-2026`, hoặc đổi thành mã khác chỉ Minh/Vũ biết).
   - (`JWT_SECRET` Render tự sinh ngẫu nhiên giúp bạn rồi, không cần điền.)
4. Bấm **Deploy**. Sau 2-3 phút, Render cho bạn 1 link dạng `https://duc-minh-clinic.onrender.com` — **đây chính là link công khai, ai có link cũng vào được.**

> Lưu ý gói Render miễn phí: server "ngủ" sau ~15 phút không ai truy cập, người vào đầu tiên sau đó phải đợi khoảng 30-50 giây để server thức dậy. Đây là giới hạn bình thường của gói free, không phải lỗi.

## Bước 5 — Tạo tài khoản admin cho Vũ

Vào link công khai ở trên → `/tai-khoan.html` → tab **Đăng ký**:
- Vũ điền tên, email, số điện thoại, mật khẩu thật của Vũ.
- Ở ô **Mã quản trị**, nhập đúng giá trị đã đặt ở `ADMIN_REGISTER_CODE` (Bước 4).
- Bấm **Tạo tài khoản** → tài khoản được tạo và đăng nhập ngay (xem Bước 5.5 về bước OTP đang tắt mặc định). Vũ đăng nhập vào sẽ thấy ngay bảng **"Danh sách tài khoản"** ở dưới — xem toàn bộ người dùng đã đăng ký, cấp/hạ quyền admin cho người khác, hoặc xoá tài khoản.

## Bước 5.5 — Về bước xác thực OTP (2FA)

Hệ thống có sẵn đầy đủ code xác thực OTP 2 bước qua email (đăng ký/đăng nhập phải nhập thêm mã 6 số gửi tới email) — **nhưng đang TẮT mặc định** (biến `REQUIRE_OTP` không đặt hoặc khác `true`), nên hiện tại đăng ký/đăng nhập chỉ cần đúng mật khẩu là cấp tài khoản ngay, không cần nhập OTP. Lý do tắt: OTP cần gửi được email thật qua SMTP, mà tài khoản Google dùng thử lại không tạo được "Mật khẩu ứng dụng" (cần bật Xác minh 2 bước trước, một số tài khoản Google còn bị ẩn hẳn tính năng này).

Muốn bật lại OTP (vd để demo/báo cáo đúng như đặc tả UC001), làm theo thứ tự:

1. Bật xác minh 2 bước cho 1 tài khoản Gmail, vào https://myaccount.google.com/apppasswords tạo "Mật khẩu ứng dụng" (khác mật khẩu Gmail thật). Nếu tài khoản đó không cho tạo (báo "cài đặt không khả dụng"), thử tài khoản Gmail cá nhân khác, hoặc dùng SMTP miễn phí khác (vd Brevo/Sendinblue) — chỉ cần đổi `SMTP_HOST`.
2. Vào Render → **Environment** → thêm:
   - `SMTP_HOST` = `smtp.gmail.com`
   - `SMTP_PORT` = `587`
   - `SMTP_USER` = địa chỉ Gmail dùng để gửi
   - `SMTP_PASS` = mật khẩu ứng dụng vừa tạo ở bước 1
   - `REQUIRE_OTP` = `true`
   - (tuỳ chọn) `SMTP_FROM` = tên + địa chỉ hiện ở ô "Người gửi" của email OTP; bỏ trống thì dùng luôn `SMTP_USER`
3. Render tự deploy lại — từ lúc này đăng ký/đăng nhập bắt buộc qua OTP thật gửi email, đúng lớp xác thực 2 bước (2FA) theo yêu cầu bảo mật của đồ án.

Không cần sửa code gì để bật/tắt — chỉ cần đổi 4 biến môi trường ở trên.

Ai đăng ký công khai (không biết mã) sẽ luôn thành tài khoản **bệnh nhân** thường — chỉ người biết mã mới tạo được tài khoản admin. Sau khi có 1 admin rồi, admin đó có thể cấp quyền admin cho người khác ngay trong bảng, không cần dùng lại mã nữa.

**Nhớ đổi `ADMIN_REGISTER_CODE` sau khi Vũ đã có tài khoản admin** (sửa lại trong Render → Environment), để tránh người ngoài đoán được mã cũ.

---

## Bước 6 — Bật AI thật miễn phí (chatbot + tóm tắt bệnh sử cho bác sĩ)

Dùng **Google Gemini** — có gói miễn phí thật sự, không cần thẻ thanh toán. Mặc định 2 tính năng AI này **tắt** (chatbot dùng bộ trả lời từ khoá dự phòng, nút "Tóm tắt AI" báo lỗi "chưa cấu hình"). Để bật thật:

1. Vào https://aistudio.google.com/apikey → đăng nhập bằng tài khoản Gmail bất kỳ (không cần thẻ).
2. Bấm **Create API key** → chọn hoặc tạo 1 project bất kỳ → copy key (dạng `AIzaSy...`).
3. Vào Render → service `duc-minh-clinic` → **Environment** → thêm biến `GEMINI_API_KEY` = key vừa tạo → Save.
4. Render tự deploy lại. Vào trang chủ thử hỏi khung chat, hoặc đăng nhập bác sĩ vào `/kham-benh.html` bấm "Tóm tắt AI bệnh sử".

**Lưu ý:** gói miễn phí của Gemini giới hạn khoảng **20 lượt gọi/ngày cho mỗi model** — hết hạn ngạch thì chatbot báo "hết hạn ngạch hôm nay" và phải chờ sang ngày hôm sau. Không dán key này vào chat hay chia sẻ công khai — chỉ nhập trực tiếp trong Render.

Tuỳ chọn đổi model (không bắt buộc, mặc định `gemini-3.6-flash`):
- `GEMINI_CHAT_MODEL` — model cho chatbot trang chủ, trợ lý trong Không gian làm việc và bước mở rộng câu hỏi RAG.
- `GEMINI_SUMMARY_MODEL` — model cho nút "Tóm tắt AI bệnh sử" của bác sĩ.

Chatbot lấy ngữ cảnh (giá khám, bác sĩ theo chuyên khoa) trực tiếp từ CSDL thật của phòng khám — không tự bịa thông tin y khoa. Tóm tắt bệnh sử chỉ dùng đúng dữ liệu hồ sơ khám đã lưu, không suy đoán thêm.

## Bước 6.5 — (Tuỳ chọn) Chạy AI ngay trên máy bằng Ollama

Có thể dùng mô hình AI chạy trên máy qua [Ollama](https://ollama.com) thay cho Gemini — không bị giới hạn 20 lượt/ngày.
Server chạy cùng máy thì làm theo các bước dưới; muốn **bản deploy trên Render** cũng dùng Ollama của laptop thì
làm thêm Bước 6.6.

1. Cài Ollama, rồi tải model phù hợp với card đồ hoạ:
   - Card rời **4 GB VRAM** (vd RTX 3050 Laptop): `ollama pull qwen3:1.7b` — nằm trọn trên GPU, mỗi câu trả lời ~1–4 giây.
     `qwen3:4b-instruct` không vừa 4 GB (khoảng 1/3 phải chạy bằng CPU) nên mất 10–40 giây/câu.
     Muốn câu trả lời chi tiết hơn mà chấp nhận ~10 giây/câu: bản 4B nén Q3
     `ollama pull hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:UD-Q3_K_XL` (đặt nguyên tên này vào `OLLAMA_MODEL`).
   - Card **≥ 6 GB VRAM**: `ollama pull qwen3:4b-instruct` — trả lời chi tiết hơn.
   - **Không** dùng `qwen3:4b` — bản đó là Thinking-2507, luôn "suy nghĩ" dài, mỗi câu trả lời chậm 20–60 giây.
2. Thêm vào file `.env`:
   ```
   AI_PROVIDER=ollama
   OLLAMA_MODEL=qwen3:1.7b
   OLLAMA_HOST=http://127.0.0.1:11434
   ```
3. (Nên làm) Đặt 2 biến môi trường **của Windows** (không phải `.env`) để giảm bộ nhớ ngữ cảnh, rồi thoát hẳn
   Ollama ở khay hệ thống và mở lại:
   ```
   setx OLLAMA_FLASH_ATTENTION 1
   setx OLLAMA_KV_CACHE_TYPE q8_0
   ```
4. `npm run dev` lại server. Kiểm tra bằng `ollama ps`: cột PROCESSOR phải là `100% GPU`.

**Máy có 2 card (Intel Iris Xe + NVIDIA):** nếu Ollama khởi động lúc máy thiếu RAM, nó không khởi tạo được CUDA
và lặng lẽ chạy model trên card Intel (Task Manager thấy GPU 0 – Intel 100%, GPU 1 – NVIDIA 0%), chậm gấp
nhiều lần. Khi đó đóng bớt ứng dụng (Chrome, Discord…), thoát Ollama ở khay hệ thống rồi mở lại.
Không đặt `OLLAMA_IGPU_ENABLE=1`: Ollama không chia model ra 2 card mà dồn hết sang card Intel (dùng chung RAM, chậm).

Các biến tuỳ chọn khác (xem chú thích trong `.env.example`):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `OLLAMA_NUM_CTX` | `8192` | Độ dài ngữ cảnh tối đa (token). Không nên để thấp hơn 8192 vì prompt chatbot dài |
| `OLLAMA_KEEP_ALIVE` | `30m` | Giữ model trong bộ nhớ bao lâu sau câu hỏi cuối |
| `AI_QUERY_EXPANSION` | bật với Gemini, tắt với Ollama | Bước mở rộng câu hỏi Multi-Query + HyDE (tốn thêm 1 lượt gọi AI mỗi câu) |

**Lưu ý:** dù dùng Ollama, phần tìm kiếm tài liệu y khoa (RAG) vẫn nhúng vector bằng Gemini — muốn chatbot trích dẫn được Cẩm nang MSD thì vẫn cần `GEMINI_API_KEY`.
Gọi Ollama lỗi (chưa mở Ollama, laptop tắt…) mà có `GEMINI_API_KEY` thì server tự chuyển sang Gemini cho câu đó.

## Bước 6.6 — (Tuỳ chọn) Cho bản deploy trên Render dùng Ollama của laptop

Laptop mở 1 đường hầm Cloudflare (miễn phí, không cần tài khoản) để Render gọi về Ollama. Ollama không có mật
khẩu, nên đường hầm trỏ vào 1 proxy có khoá (`OLLAMA_API_KEY`) chỉ cho đi qua đúng `POST /api/chat`.

```
Trình duyệt → Render (server) → https://xxx.trycloudflare.com → proxy có khoá :11435 → Ollama :11434 (laptop)
```

Cài đặt **1 lần**:

1. Cài cloudflared: `winget install --id Cloudflare.cloudflared` (mở terminal mới sau khi cài).
2. `.env` của laptop: `OLLAMA_API_KEY=<chuỗi bí mật dài>` và `REMOTE_SERVER_URL=https://duc-minh-clinic.onrender.com`.
   Tạo chuỗi: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
3. Render → service → **Environment**: thêm `AI_PROVIDER=ollama`, `OLLAMA_MODEL=qwen3:1.7b`,
   `OLLAMA_API_KEY=<đúng chuỗi ở bước 2>` (giữ `GEMINI_API_KEY` để dự phòng). Lưu → Render tự deploy lại.

Mỗi lần dùng: mở Ollama, rồi `npm run tunnel` (để cửa sổ đó chạy). Script mở đường hầm, cứ 2 phút báo địa chỉ
đường hầm lên Render (`POST /api/ai/ollama-endpoint`, bắt buộc đúng khoá), giữ model nạp sẵn và giữ bản Render
miễn phí không "ngủ". Mỗi lượt web gọi Ollama được in ra cửa sổ đó.

Tắt script hoặc tắt laptop: sau tối đa 5 phút Render tự quay về Gemini (trong lúc đó các câu hỏi cũng tự
chuyển sang Gemini vì gọi đường hầm lỗi). Nếu Ollama lỗi **sau khi** đã chạy công cụ (vd đặt lịch) thì không
chuyển sang Gemini — tránh đặt lịch trùng — mà báo lỗi để khách thử lại.

---

## API

| Method | Endpoint | Ai gọi được | Việc làm |
|---|---|---|---|
| POST | `/api/auth/register` | Ai cũng gọi được | `REQUIRE_OTP=true`: gửi mã OTP tới email, trả `ticket` (chưa tạo tài khoản). Mặc định (tắt): tạo tài khoản luôn, trả `token` |
| POST | `/api/auth/register/verify` | Ai cũng gọi được | Chỉ dùng khi `REQUIRE_OTP=true` — đúng `ticket` + mã OTP thì mới tạo tài khoản thật → trả về `token` |
| POST | `/api/auth/login` | Ai cũng gọi được | `REQUIRE_OTP=true`: kiểm tra mật khẩu rồi gửi mã OTP, trả `ticket`. Mặc định (tắt): kiểm tra mật khẩu rồi cấp `token` luôn |
| POST | `/api/auth/login/verify` | Ai cũng gọi được | Chỉ dùng khi `REQUIRE_OTP=true` — đúng `ticket` + mã OTP thì mới cấp `token` (2FA) |
| GET | `/api/auth/me` | Đã đăng nhập | Thông tin tài khoản đang đăng nhập |
| GET / POST | `/api/admin/users` | Chỉ admin | Danh sách / tạo tài khoản mới (kể cả Bác sĩ, Nhân viên) |
| PATCH / DELETE | `/api/admin/users/:id` | Chỉ admin | Đổi vai trò / xoá tài khoản |
| POST / GET | `/api/appointments` | Bệnh nhân đặt; Nhân viên/Bác sĩ/Admin xem hàng đợi | Đặt lịch khám / xem hàng đợi theo ngày |
| GET | `/api/appointments/mine` | Bệnh nhân | Lịch hẹn của chính mình |
| PATCH | `/api/appointments/:id/status` | Theo vai trò | Đổi trạng thái lịch hẹn (bệnh nhân chỉ tự huỷ được) |
| GET / POST / PATCH / DELETE | `/api/clinical/medicines` | Xem: ai cũng được; Sửa: admin | Danh mục thuốc + giá |
| GET / POST / DELETE | `/api/clinical/interactions` | Xem: ai cũng được; Sửa: admin | Quy tắc tương tác thuốc |
| GET / POST / DELETE | `/api/schedule/doctor-shifts` | Xem: admin (mọi bác sĩ) hoặc bác sĩ (của mình); Sửa: admin | Ca trực/lịch làm việc theo tuần của bác sĩ |
| PATCH | `/api/admin/users/:id/status` | Chỉ admin | Khoá/mở khoá tài khoản (JWT cũ mất hiệu lực ngay khi khoá) |
| GET | `/api/stats/export.xlsx` | Chỉ admin | Xuất báo cáo thống kê ra file Excel (.xlsx) thật |
| POST | `/api/clinical/check-interactions` | Đã đăng nhập | Kiểm tra cảnh báo tương tác cho 1 danh sách thuốc, kèm gợi ý thuốc thay thế (`substitutesA`/`substitutesB`) cho từng cảnh báo |
| GET | `/api/clinical/medicines/:id/substitutes` | Đã đăng nhập | Thuốc thay thế (cùng nhóm) cho 1 thuốc cụ thể, đánh dấu thuốc nào vẫn tương tác với các thuốc khác đang kê (`otherMedicineIds`) |
| POST | `/api/clinical/records` | Bác sĩ | Tạo hồ sơ khám + đơn thuốc, tự hoàn thành lịch hẹn |
| GET | `/api/clinical/records/mine` | Bệnh nhân | Lịch sử khám của chính mình |
| GET / PUT | `/api/billing/service-prices` | Xem: nhân viên/bác sĩ/admin; Sửa: admin | Giá khám theo chuyên khoa |
| GET / PUT | `/api/billing/bank-account` | Xem: đã đăng nhập; Sửa: admin | Tài khoản ngân hàng nhận thanh toán QR (VietQR) |
| POST / GET | `/api/billing/invoices` | Lập: nhân viên/admin | Lập hoá đơn cho lịch hẹn đã khám xong |
| PATCH | `/api/billing/invoices/:id/status` | Nhân viên/admin | Xác nhận đã thu tiền |
| PATCH | `/api/billing/invoices/:id/claim-online-payment` | Bệnh nhân (chủ hoá đơn) | Báo đã chuyển khoản qua QR — chỉ đánh dấu để nhân viên ưu tiên đối chiếu, KHÔNG tự động xác nhận đã thu tiền |
| GET | `/api/billing/invoices/:id/payment-status` | Chủ hoá đơn, nhân viên/bác sĩ/admin | Chỉ trả trạng thái thanh toán (không ghi nhật ký) — trang Hồ sơ gọi sau khi bệnh nhân báo chuyển khoản (3 lần đầu 5 giây/lần, sau đó 30 giây/lần, tối đa ~10 phút): có xác nhận thì báo "Chuyển khoản thành công", lần 3 vẫn chưa có thì yêu cầu gọi nhân viên hỗ trợ |
| POST | `/api/ai/chat` | Ai cũng gọi được | Chatbot AI (Gemini, hoặc Ollama khi `AI_PROVIDER=ollama`) |
| POST | `/api/ai/ollama-endpoint` | Laptop chạy `npm run tunnel` (khoá `OLLAMA_API_KEY`) | Báo địa chỉ đường hầm Ollama hiện tại |
| POST | `/api/ai/summarize-patient` | Bác sĩ/nhân viên/admin | Tóm tắt AI bệnh sử 1 bệnh nhân |

Các API cần đăng nhập thì gửi kèm header `Authorization: Bearer <token>`.

## Vì sao không dùng bản thiết kế trên Claude Artifact cho việc này?

Trang mình từng publish trên Claude Artifact bị nền tảng **chặn mọi kết nối mạng ra ngoài** (không gọi API được) — nên nó không thể nối tới backend/CSDL thật. Vì vậy toàn bộ giao diện đã được chuyển hẳn vào đây, chạy chung với backend, để deploy một link duy nhất dùng thật được.
