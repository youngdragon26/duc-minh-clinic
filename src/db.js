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
}

const ROLES = ['admin', 'patient', 'doctor', 'staff'];

module.exports = { pool, init, ROLES };
