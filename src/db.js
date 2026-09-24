const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Thiếu DATABASE_URL trong file .env — xem .env.example (lấy chuỗi kết nối miễn phí từ Neon/Supabase).');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  // Neon/Supabase yêu cầu SSL nhưng dùng chứng chỉ tự ký nội bộ.
  ssl: connectionString.includes('sslmode=require') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : undefined,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'patient' CHECK (role IN ('admin','patient')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Mở rộng vai trò cho CSDL đã tồn tại từ trước (chỉ có admin/patient) —
  // ALTER này chạy lại mỗi lần khởi động nhưng vô hại vì luôn cùng một kết quả.
  await pool.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin','patient','doctor','staff'));
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS specialty TEXT;`);
  // Lý lịch/giới thiệu bác sĩ — bệnh nhân xem được khi đặt lịch hoặc xem chi
  // tiết lịch hẹn (chỉ có ý nghĩa với tài khoản role = 'doctor').
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;`);

  // Trạng thái tài khoản (UC012: "quản lý trạng thái tài khoản", tách biệt với vai
  // trò RBAC) — admin khoá tạm 1 tài khoản (vd nhân viên nghỉ việc) mà không cần
  // xoá hẳn, giữ lại toàn bộ lịch sử/hồ sơ liên quan. Tài khoản bị khoá không đăng
  // nhập được (chặn ngay ở bước 1, trước khi gửi OTP) nhưng dữ liệu vẫn còn nguyên.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;`);

  // SĐT dùng để đăng nhập thay email (UC001) nên phải là duy nhất — nhưng có thể
  // NULL/rỗng (chưa khai báo) và nhiều tài khoản cùng để trống thì không tính là
  // trùng. Bọc try/catch vì CSDL cũ có thể đã lỡ có SĐT trùng nhau trước khi ràng
  // buộc này tồn tại — không nên làm sập cả server chỉ vì lỗi này, chỉ cảnh báo để
  // admin tự dọn dữ liệu.
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_users_phone ON users (phone)
      WHERE phone IS NOT NULL AND phone <> '';
    `);
  } catch (e) {
    console.warn('Không tạo được ràng buộc SĐT duy nhất (có thể do dữ liệu cũ bị trùng SĐT):', e.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doctor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      specialty TEXT NOT NULL,
      appointment_date DATE NOT NULL,
      appointment_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'cho_xac_nhan'
        CHECK (status IN ('cho_xac_nhan','da_xac_nhan','da_checkin','dang_kham','hoan_thanh','da_huy')),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Thông tin người khám khai báo riêng cho từng lượt đặt lịch (có thể khác
  // thông tin tài khoản, vd đặt hộ người thân) — thu thập ngay lúc đặt lịch.
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS contact_name TEXT;`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS contact_phone TEXT;`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS age INTEGER;`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS gender TEXT;`);
  await pool.query(`
    ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_gender_check;
    ALTER TABLE appointments ADD CONSTRAINT appointments_gender_check
      CHECK (gender IS NULL OR gender IN ('nam','nu','khac'));
  `);

  // Đối tượng ưu tiên bệnh nhân tự khai lúc đặt lịch (BHYT/thẻ sinh viên) — chỉ
  // 1 loại, không cộng dồn. NULL nghĩa là không thuộc đối tượng ưu tiên nào.
  // Nhân viên vẫn phải xác minh thẻ thật khi lập hoá đơn, khai sai chỉ ảnh
  // hưởng tới % giảm giá áp cho phí khám, không tự động miễn phí gì cả.
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS discount_category TEXT;`);
  await pool.query(`
    ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_discount_category_check;
    ALTER TABLE appointments ADD CONSTRAINT appointments_discount_category_check
      CHECK (discount_category IS NULL OR discount_category IN ('bhyt','sinh_vien'));
  `);

  // Chặn 2 lịch hẹn trùng giờ của cùng 1 bác sĩ ở tầng CSDL (không chỉ kiểm tra
  // ở code) để tránh race condition khi 2 người đặt cùng lúc — lịch đã huỷ thì
  // không tính vào, nên giờ đó lại đặt được cho người khác.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_doctor_slot
      ON appointments (doctor_id, appointment_date, appointment_time)
      WHERE doctor_id IS NOT NULL AND status <> 'da_huy';
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_appointments_date ON appointments (appointment_date);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS medicines (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      unit TEXT NOT NULL DEFAULT 'viên',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS drug_interactions (
      id SERIAL PRIMARY KEY,
      medicine_a_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      medicine_b_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      severity TEXT NOT NULL CHECK (severity IN ('nhe','trung_binh','nghiem_trong')),
      description TEXT NOT NULL,
      CHECK (medicine_a_id <> medicine_b_id)
    );
  `);
  // 1 cặp thuốc chỉ có 1 quy tắc tương tác, không phân biệt thứ tự nhập A/B.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_drug_interactions_pair
      ON drug_interactions (LEAST(medicine_a_id, medicine_b_id), GREATEST(medicine_a_id, medicine_b_id));
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS medical_records (
      id SERIAL PRIMARY KEY,
      appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
      patient_id INTEGER NOT NULL REFERENCES users(id),
      doctor_id INTEGER NOT NULL REFERENCES users(id),
      symptoms TEXT,
      diagnosis TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS prescription_items (
      id SERIAL PRIMARY KEY,
      medical_record_id INTEGER NOT NULL REFERENCES medical_records(id) ON DELETE CASCADE,
      medicine_id INTEGER NOT NULL REFERENCES medicines(id),
      dosage TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1
    );
  `);

  // ---------- RAG: cơ sở tri thức (Indexing phase) ----------
  // text-embedding-004 của Gemini sinh vector 768 chiều.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_documents (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id SERIAL PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding vector(3072),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // gemini-embedding-001 sinh vector 3072 chiều — sửa lại cho CSDL đã tồn tại
  // từ trước khi biết đúng số chiều (bảng khi đó chưa có dữ liệu nào).
  await pool.query(`DROP INDEX IF EXISTS ix_kb_chunks_embedding;`);
  await pool.query(`ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE vector(3072);`);

  // KHÔNG tạo chỉ mục HNSW/IVFFlat: pgvector giới hạn các loại chỉ mục này tối
  // đa 2000 chiều, trong khi vector ở đây có 3072 chiều — tạo chỉ mục sẽ làm
  // toàn bộ server sập khi khởi động (đã xảy ra thật, đây là bản vá cho lỗi đó).
  // Không có chỉ mục thì similarity search vẫn đúng, chỉ là quét tuần tự thay vì
  // ANN — hoàn toàn ổn với quy mô vài trăm tài liệu như 1 phòng khám nhỏ.

  await pool.query(`ALTER TABLE medicines ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0;`);

  // Nhóm thuốc/hoạt chất (vd "Hạ sốt - giảm đau (Paracetamol)") — admin tự đặt tên
  // nhóm khi 2 thuốc có thể dùng thay thế nhau. Cùng group_name (khác NULL) thì
  // được coi là thuốc thay thế của nhau (UC006: "hỗ trợ gợi ý thuốc thay thế").
  await pool.query(`ALTER TABLE medicines ADD COLUMN IF NOT EXISTS group_name TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_medicines_group ON medicines (group_name) WHERE group_name IS NOT NULL;`);

  // Giá khám theo từng chuyên khoa — admin thiết lập trong "Bảng giá dịch vụ".
  // Không có dòng cho 1 chuyên khoa nghĩa là CHƯA thiết lập giá (khác với giá 0đ = miễn phí).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_prices (
      specialty TEXT PRIMARY KEY,
      price INTEGER NOT NULL DEFAULT 0
    );
  `);

  // % giảm giá theo đối tượng ưu tiên (BHYT/thẻ sinh viên), admin thiết lập
  // trong "Bảng giá dịch vụ" — không có dòng cho 1 loại nghĩa là 0% (chưa giảm).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discount_rates (
      category TEXT PRIMARY KEY CHECK (category IN ('bhyt','sinh_vien')),
      percent INTEGER NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 100)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
      patient_id INTEGER NOT NULL REFERENCES users(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      total_amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'chua_thanh_toan' CHECK (status IN ('chua_thanh_toan','da_thanh_toan')),
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Hình thức thanh toán — chỉ có giá trị khi hoá đơn đã được xác nhận thu tiền.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method TEXT;`);
  await pool.query(`
    ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_method_check;
    ALTER TABLE invoices ADD CONSTRAINT invoices_payment_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('tien_mat','chuyen_khoan'));
  `);

  // Bệnh nhân tự bấm "Tôi đã chuyển khoản" sau khi quét mã QR thanh toán online —
  // KHÔNG tự động đánh dấu đã thu tiền (chưa có cổng thanh toán/webhook ngân hàng
  // thật, đúng tinh thần "Human-in-the-Loop" của đồ án): nhân viên vẫn phải đối
  // chiếu sao kê rồi mới xác nhận qua PATCH .../status như cũ. Cột này chỉ để nhân
  // viên biết hoá đơn nào cần ưu tiên kiểm tra.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS online_payment_claimed_at TIMESTAMPTZ;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price INTEGER NOT NULL DEFAULT 0,
      subtotal INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Nhật ký hoạt động: ai làm gì, lúc nào, với đối tượng nào. Chỉ thêm, không
  // sửa/xoá qua ứng dụng. user_name/role chép lại tại thời điểm ghi để dòng
  // nhật ký vẫn đọc được kể cả khi tài khoản sau đó bị xoá hoặc đổi vai trò.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      user_name TEXT,
      user_role TEXT,
      action TEXT NOT NULL,
      entity TEXT,
      entity_id INTEGER,
      detail JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_audit_logs_created ON audit_logs (created_at DESC);`);

  // Hẹn tái khám do bác sĩ đặt sau mỗi lần khám.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS followups (
      id SERIAL PRIMARY KEY,
      medical_record_id INTEGER NOT NULL REFERENCES medical_records(id) ON DELETE CASCADE,
      patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followup_date DATE NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'cho' CHECK (status IN ('cho','da_den','da_huy')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_followups_doctor_date ON followups (doctor_id, followup_date);`);

  // Ca trực / lịch làm việc theo tuần của bác sĩ (UC009). weekday khớp đúng quy
  // ước EXTRACT(DOW) của Postgres và Date.getUTCDay() của JS: 0 = Chủ nhật ... 6 =
  // Thứ 7 — để so trực tiếp không cần quy đổi qua lại. Bác sĩ CHƯA có dòng nào ở
  // đây thì mặc định coi như làm việc cả ngày theo khung giờ chung của phòng khám
  // (như hành vi cũ trước khi có bảng này) — xem lib/availability.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doctor_shifts (
      id SERIAL PRIMARY KEY,
      doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      CHECK (start_time < end_time)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_doctor_shifts_doctor ON doctor_shifts (doctor_id, weekday);`);

  // Mã OTP xác thực đăng ký/đăng nhập (UC001, 2FA). "payload" chứa dữ liệu tạm
  // cần thiết để hoàn tất hành động SAU KHI xác thực đúng mã — vd lúc đăng ký thì
  // tài khoản CHƯA được tạo ở bước gửi OTP, chỉ tạo thật khi verify đúng mã, nên
  // phải giữ tạm name/email/sđt/mật khẩu đã băm ở đây.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      ticket TEXT NOT NULL UNIQUE,
      destination TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('register','login')),
      code_hash TEXT NOT NULL,
      payload JSONB NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_otp_codes_destination ON otp_codes (destination, purpose);`);

  // Thông tin tài khoản ngân hàng phòng khám dùng để sinh mã QR thanh toán online
  // (VietQR) — luôn đúng 1 dòng duy nhất (id cố định = 1), admin thiết lập trong
  // "Danh mục thuốc & tương tác thuốc". bank_bin là mã ngân hàng theo chuẩn Napas/
  // VietQR (vd 970436 = Vietcombank), KHÔNG phải mã số thuế hay số điện thoại.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_account (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      bank_bin TEXT,
      bank_name TEXT,
      account_number TEXT,
      account_name TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Lịch sử trò chuyện với trợ lý AI của bệnh nhân ĐÃ ĐĂNG NHẬP — để mở lại xem hoặc
  // chat tiếp. Khách chưa đăng nhập không lưu ở CSDL (chỉ nhớ tạm trong trình duyệt).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // channel: 'main' = khung chat chính ở trang chủ (khách + bệnh nhân),
  // 'assistant' = trợ lý AI riêng của bác sĩ/nhân viên/admin trong không gian làm việc.
  await pool.query(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'main';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_chat_conversations_user ON chat_conversations (user_id, updated_at DESC);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_chat_messages_conv ON chat_messages (conversation_id, id);`);
}

const ROLES = ['admin', 'patient', 'doctor', 'staff'];

module.exports = { pool, init, ROLES };
