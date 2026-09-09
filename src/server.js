require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const { init } = require('./db');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const appointmentRoutes = require('./routes/appointments');
const clinicalRoutes = require('./routes/clinical');

if (!process.env.JWT_SECRET) {
  console.error('Thiếu JWT_SECRET trong file .env — xem .env.example.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/clinical', clinicalRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Đa Khoa Đức Minh backend đang chạy tại http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Không kết nối được CSDL:', e.message);
    process.exit(1);
  });
