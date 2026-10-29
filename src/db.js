const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Thiếu DATABASE_URL trong file .env — xem .env.example (lấy chuỗi kết nối miễn phí từ Neon/Supabase).');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  // Neon/Supabase yêu cầu SSL nhưng dùng chứng chỉ tự ký.
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

  // Mở rộng vai trò cho CSDL cũ (chỉ có admin/patient).
  await pool.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin','patient','doctor','staff'));
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS specialty TEXT;`);
  // Lý lịch bác sĩ — bệnh nhân xem khi đặt lịch (chỉ có nghĩa với role = 'doctor').
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;`);

  // Admin khoá tạm tài khoản mà không xoá, giữ nguyên lịch sử/hồ sơ. Tài khoản khoá không đăng nhập được.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;`);

  // SĐT đăng nhập thay email nên phải duy nhất (được để trống). Bọc try/catch: CSDL cũ có thể đã có SĐT trùng —
  // chỉ cảnh báo, không làm sập server.
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

  // Thông tin người khám riêng cho từng lượt đặt (có thể đặt hộ người thân).
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS contact_name TEXT;`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS contact_phone TEXT;`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS age INTEGER;`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS gender TEXT;`);
  await pool.query(`
    ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_gender_check;
    ALTER TABLE appointments ADD CONSTRAINT appointments_gender_check
      CHECK (gender IS NULL OR gender IN ('nam','nu','khac'));
  `);

  // Đối tượng ưu tiên tự khai (BHYT/sinh viên) — chỉ 1 loại, nhân viên xác minh thẻ khi lập hoá đơn.
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS discount_category TEXT;`);
  await pool.query(`
    ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_discount_category_check;
    ALTER TABLE appointments ADD CONSTRAINT appointments_discount_category_check
      CHECK (discount_category IS NULL OR discount_category IN ('bhyt','sinh_vien'));
  `);

  // Chặn 2 lịch trùng giờ của cùng 1 bác sĩ ở tầng CSDL (race condition); lịch đã huỷ không tính.
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
  // 1 cặp thuốc chỉ có 1 quy tắc tương tác, không phân biệt thứ tự A/B.
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

  // ---------- RAG: cơ sở tri thức ----------
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

  // gemini-embedding-001 sinh vector 3072 chiều — sửa cho CSDL tạo từ trước.
  await pool.query(`DROP INDEX IF EXISTS ix_kb_chunks_embedding;`);
  await pool.query(`ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE vector(3072);`);

  // KHÔNG tạo chỉ mục HNSW/IVFFlat: pgvector giới hạn 2000 chiều, vector ở đây 3072 chiều — tạo chỉ mục làm sập
  // server khi khởi động. Quét tuần tự là đủ với quy mô 1 phòng khám.

  // Câu trả lời mẫu (few-shot) cho chatbot. local_embedding do Ollama (OLLAMA_EMBED_MODEL) tạo — không ghi số chiều
  // để đổi model không phải sửa bảng; KHÔNG tạo chỉ mục.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_examples (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      local_embedding vector,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Cột "embedding" cũ (Gemini) bỏ hẳn; tên cột mới khác để lệnh DROP không xoá vector mới.
  await pool.query(`ALTER TABLE chat_examples ADD COLUMN IF NOT EXISTS local_embedding vector;`);
  await pool.query(`ALTER TABLE chat_examples DROP COLUMN IF EXISTS embedding;`);

  await pool.query(`ALTER TABLE medicines ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0;`);

  // Cùng group_name (khác NULL) = thuốc thay thế được cho nhau.
  await pool.query(`ALTER TABLE medicines ADD COLUMN IF NOT EXISTS group_name TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_medicines_group ON medicines (group_name) WHERE group_name IS NOT NULL;`);

  // Giá khám theo chuyên khoa. Không có dòng = CHƯA thiết lập giá (khác 0đ = miễn phí).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_prices (
      specialty TEXT PRIMARY KEY,
      price INTEGER NOT NULL DEFAULT 0
    );
  `);

  // % giảm giá theo đối tượng ưu tiên; không có dòng = 0%.
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

  // Chỉ có giá trị khi hoá đơn đã xác nhận thu tiền.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method TEXT;`);
  await pool.query(`
    ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_method_check;
    ALTER TABLE invoices ADD CONSTRAINT invoices_payment_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('tien_mat','chuyen_khoan'));
  `);

  // Bệnh nhân tự báo "đã chuyển khoản" — KHÔNG tự đánh dấu đã thu (chưa có webhook ngân hàng); nhân viên đối chiếu
  // sao kê rồi xác nhận qua PATCH .../status.
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

  // Nhật ký hoạt động: chỉ thêm. user_name/role chép tại thời điểm ghi để vẫn đọc được khi tài khoản bị xoá/đổi vai trò.
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

  // Ca trực theo tuần. weekday theo EXTRACT(DOW)/getUTCDay(): 0 = Chủ nhật … 6 = Thứ 7.
  // Bác sĩ chưa có dòng nào = làm cả ngày theo giờ chung (xem lib/availability.js).
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

  // Mã OTP. payload giữ dữ liệu tạm để hoàn tất hành động sau khi xác thực (vd đăng ký: tài khoản chỉ tạo khi đúng mã).
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

  // Tài khoản ngân hàng cho mã VietQR — luôn đúng 1 dòng (id = 1). bank_bin là mã ngân hàng Napas (970436 = Vietcombank).
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

  // Lịch sử chat của người dùng đã đăng nhập; khách chưa đăng nhập chỉ lưu trong trình duyệt.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // channel: 'main' = chatbot trang chủ, 'assistant' = trợ lý trong không gian làm việc.
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
