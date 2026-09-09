# Đa Khoa Đức Minh — Website + tài khoản

Một web Node.js/Express thật, phục vụ:
- **Trang chủ** (`public/index.html`) — landing page giới thiệu phòng khám.
- **Trang đăng nhập/đăng ký** (`public/tai-khoan.html`) — tách riêng như yêu cầu.
- **API tài khoản** (`/api/auth/...`, `/api/admin/...`) — mật khẩu mã hoá bcrypt, đăng nhập bằng JWT, CSDL **PostgreSQL thật** (không phải SQLite nữa, để không mất dữ liệu khi deploy công khai và server khởi động lại).

Mục tiêu bạn đang hướng tới: **một link duy nhất, ai có link cũng vào được, tự đăng ký tài khoản, và Vũ là admin xem/sửa được danh sách tài khoản.** Dưới đây là các bước để làm điều đó.

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
- Bấm **Tạo tài khoản** → Vũ đăng nhập vào sẽ thấy ngay bảng **"Danh sách tài khoản"** ở dưới — xem toàn bộ người dùng đã đăng ký, cấp/hạ quyền admin cho người khác, hoặc xoá tài khoản.

Ai đăng ký công khai (không biết mã) sẽ luôn thành tài khoản **bệnh nhân** thường — chỉ người biết mã mới tạo được tài khoản admin. Sau khi có 1 admin rồi, admin đó có thể cấp quyền admin cho người khác ngay trong bảng, không cần dùng lại mã nữa.

**Nhớ đổi `ADMIN_REGISTER_CODE` sau khi Vũ đã có tài khoản admin** (sửa lại trong Render → Environment), để tránh người ngoài đoán được mã cũ.

---

## API

| Method | Endpoint | Ai gọi được | Việc làm |
|---|---|---|---|
| POST | `/api/auth/register` | Ai cũng gọi được | Tạo tài khoản mới (`name`, `email`, `phone`, `password`, `adminCode?`) |
| POST | `/api/auth/login` | Ai cũng gọi được | Đăng nhập (`email`, `password`) → trả về `token` |
| GET | `/api/auth/me` | Đã đăng nhập | Xem thông tin tài khoản đang đăng nhập |
| GET | `/api/admin/users` | Chỉ admin | Danh sách toàn bộ tài khoản |
| PATCH | `/api/admin/users/:id/role` | Chỉ admin | Đổi vai trò một tài khoản (`role`: `admin`/`patient`) |
| DELETE | `/api/admin/users/:id` | Chỉ admin | Xoá một tài khoản |

Các API cần đăng nhập thì gửi kèm header `Authorization: Bearer <token>`.

## Vì sao không dùng bản thiết kế trên Claude Artifact cho việc này?

Trang mình từng publish trên Claude Artifact bị nền tảng **chặn mọi kết nối mạng ra ngoài** (không gọi API được) — nên nó không thể nối tới backend/CSDL thật. Vì vậy toàn bộ giao diện (trang chủ + trang đăng nhập) đã được chuyển hẳn vào đây, chạy chung với backend, để deploy một link duy nhất dùng thật được.

Khung "Trợ lý AI" trên trang chủ ở bản này dùng bộ trả lời theo từ khoá (không gọi mô hình AI thật), vì lý do tương tự: trang web thường không có sẵn quyền gọi Claude như bên Artifact. Muốn có AI thật ở đây, cần thêm một route backend gọi API của một nhà cung cấp LLM (ví dụ Anthropic API) rồi nối vào khung chat — nói với mình khi bạn muốn làm phần này.
