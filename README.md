# Đa Khoa Đức Minh — Website + hệ thống quản lý phòng khám

Một web Node.js/Express thật, đã triển khai công khai tại **https://duc-minh-clinic.onrender.com**, gồm:

- **Trang chủ** (`/`) — landing page giới thiệu phòng khám, có khung chat AI.
- **Tài khoản** (`/tai-khoan.html`) — đăng ký/đăng nhập bằng Email hoặc SĐT + mật khẩu + mã OTP gửi qua email (2FA), 4 vai trò: Bệnh nhân, Bác sĩ, Nhân viên, Quản trị viên.
- **Đặt lịch khám** (`/dat-lich.html`) — bệnh nhân chọn chuyên khoa/bác sĩ/giờ, xem lịch của mình.
- **Hàng đợi khám** (`/hang-doi.html`) — nhân viên/bác sĩ/admin xem và cập nhật trạng thái lịch hẹn.
- **Khám bệnh** (`/kham-benh.html`) — bác sĩ ghi chẩn đoán, kê đơn thuốc, có cảnh báo tương tác thuốc kèm gợi ý thuốc thay thế cùng nhóm, và tóm tắt AI bệnh sử.
- **Hồ sơ khám bệnh** (`/ho-so.html`) — bệnh nhân xem lại lịch sử khám + đơn thuốc + hoá đơn, tự thanh toán hoá đơn chưa trả bằng mã QR chuyển khoản (VietQR).
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
- Bấm **Tạo tài khoản** → hệ thống gửi mã OTP 6 số tới email vừa nhập (xem Bước 5.5 nếu chưa cấu hình gửi email thật) → nhập đúng mã thì tài khoản mới thật sự được tạo. Vũ đăng nhập vào sẽ thấy ngay bảng **"Danh sách tài khoản"** ở dưới — xem toàn bộ người dùng đã đăng ký, cấp/hạ quyền admin cho người khác, hoặc xoá tài khoản.

Từ đây về sau, **mỗi lần đăng nhập** (mọi vai trò) cũng đều phải qua bước nhập mã OTP gửi tới email tài khoản đó — đây là lớp xác thực 2 bước (2FA) bắt buộc theo yêu cầu bảo mật của đồ án.

## Bước 5.5 — Bật gửi OTP qua email thật (không bắt buộc để chạy thử)

Mặc định (chưa cấu hình `SMTP_*`), mã OTP được **in ra log server** thay vì gửi email thật — đủ để tự test đăng ký/đăng nhập cục bộ, nhưng người dùng thật trên link công khai sẽ không nhận được mã. Để gửi email thật (miễn phí bằng Gmail):

1. Bật xác minh 2 bước cho tài khoản Gmail sẽ dùng để gửi OTP.
2. Vào https://myaccount.google.com/apppasswords → tạo 1 "Mật khẩu ứng dụng" (khác với mật khẩu Gmail thật).
3. Vào Render → **Environment** → thêm:
   - `SMTP_HOST` = `smtp.gmail.com`
   - `SMTP_PORT` = `587`
   - `SMTP_USER` = địa chỉ Gmail dùng để gửi
   - `SMTP_PASS` = mật khẩu ứng dụng vừa tạo ở bước 2
4. Render tự deploy lại — từ lúc này OTP được gửi email thật thay vì chỉ in ra log.

Ai đăng ký công khai (không biết mã) sẽ luôn thành tài khoản **bệnh nhân** thường — chỉ người biết mã mới tạo được tài khoản admin. Sau khi có 1 admin rồi, admin đó có thể cấp quyền admin cho người khác ngay trong bảng, không cần dùng lại mã nữa.

**Nhớ đổi `ADMIN_REGISTER_CODE` sau khi Vũ đã có tài khoản admin** (sửa lại trong Render → Environment), để tránh người ngoài đoán được mã cũ.

---

## Bước 6 — Bật AI thật miễn phí (chatbot + tóm tắt bệnh sử cho bác sĩ)

Dùng **Google Gemini** — có gói miễn phí thật sự, không cần thẻ thanh toán. Mặc định 2 tính năng AI này **tắt** (chatbot dùng bộ trả lời từ khoá dự phòng, nút "Tóm tắt AI" báo lỗi "chưa cấu hình"). Để bật thật:

1. Vào https://aistudio.google.com/apikey → đăng nhập bằng tài khoản Gmail bất kỳ (không cần thẻ).
2. Bấm **Create API key** → chọn hoặc tạo 1 project bất kỳ → copy key (dạng `AIzaSy...`).
3. Vào Render → service `duc-minh-clinic` → **Environment** → thêm biến `GEMINI_API_KEY` = key vừa tạo → Save.
4. Render tự deploy lại. Vào trang chủ thử hỏi khung chat, hoặc đăng nhập bác sĩ vào `/kham-benh.html` bấm "Tóm tắt AI bệnh sử".

**Lưu ý:** gói miễn phí của Gemini có giới hạn số lượt hỏi/phút — đủ dùng cho 1 phòng khám nhỏ, nếu sau này đông người dùng cùng lúc có thể cần nâng cấp. Không dán key này vào chat hay chia sẻ công khai — chỉ nhập trực tiếp trong Render.

Chatbot lấy ngữ cảnh (giá khám, bác sĩ theo chuyên khoa) trực tiếp từ CSDL thật của phòng khám — không tự bịa thông tin y khoa. Tóm tắt bệnh sử chỉ dùng đúng dữ liệu hồ sơ khám đã lưu, không suy đoán thêm.

---

## API

| Method | Endpoint | Ai gọi được | Việc làm |
|---|---|---|---|
| POST | `/api/auth/register` | Ai cũng gọi được | Bước 1/2 đăng ký: kiểm tra thông tin, gửi mã OTP tới email → trả về `ticket` (chưa tạo tài khoản) |
| POST | `/api/auth/register/verify` | Ai cũng gọi được | Bước 2/2 đăng ký: đúng `ticket` + mã OTP thì mới tạo tài khoản thật → trả về `token` |
| POST | `/api/auth/login` | Ai cũng gọi được | Bước 1/2 đăng nhập: kiểm tra Email/SĐT + mật khẩu, gửi mã OTP tới email → trả về `ticket` |
| POST | `/api/auth/login/verify` | Ai cũng gọi được | Bước 2/2 đăng nhập: đúng `ticket` + mã OTP thì mới cấp `token` (2FA) |
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
| POST | `/api/ai/chat` | Ai cũng gọi được | Chatbot AI (cần `GEMINI_API_KEY`) |
| POST | `/api/ai/summarize-patient` | Bác sĩ/nhân viên/admin | Tóm tắt AI bệnh sử 1 bệnh nhân |

Các API cần đăng nhập thì gửi kèm header `Authorization: Bearer <token>`.

## Vì sao không dùng bản thiết kế trên Claude Artifact cho việc này?

Trang mình từng publish trên Claude Artifact bị nền tảng **chặn mọi kết nối mạng ra ngoài** (không gọi API được) — nên nó không thể nối tới backend/CSDL thật. Vì vậy toàn bộ giao diện đã được chuyển hẳn vào đây, chạy chung với backend, để deploy một link duy nhất dùng thật được.
