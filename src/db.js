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

  await pool.query(`ALTER TABLE medicines ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0;`);

  // Giá khám theo từng chuyên khoa — admin thiết lập trong "Bảng giá dịch vụ".
  // Không có dòng cho 1 chuyên khoa nghĩa là CHƯA thiết lập giá (khác với giá 0đ = miễn phí).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_prices (
      specialty TEXT PRIMARY KEY,
      price INTEGER NOT NULL DEFAULT 0
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
}

const ROLES = ['admin', 'patient', 'doctor', 'staff'];

module.exports = { pool, init, ROLES };
