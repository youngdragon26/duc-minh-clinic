// Điền lý lịch (bio) và SĐT liên hệ riêng cho các tài khoản bác sĩ mẫu đã có sẵn
// trong CSDL (được tạo qua trang quản trị nhưng chưa khai bio). Chạy lại an toàn:
// chỉ cập nhật đúng những bác sĩ khớp email bên dưới, không tạo thêm bản ghi mới.
require('dotenv').config();
const { pool } = require('../src/db');

const DOCTOR_PROFILES = [
  {
    email: 'bs.tran.van.an@ducminh.local',
    phone: '0912345671',
    bio: 'Tốt nghiệp Đại học Y Hà Nội, hơn 15 năm kinh nghiệm khám và điều trị nội khoa tổng quát, tầm soát sức khỏe định kỳ. Từng công tác tại Bệnh viện Đa khoa Trung ương Thái Nguyên trước khi về phòng khám. Phong cách khám tận tâm, giải thích rõ ràng, chú trọng tư vấn phòng bệnh cho người cao tuổi và người có bệnh nền mãn tính.',
  },
  {
    email: 'bs.nguyen.thi.binh@ducminh.local',
    phone: '0912345672',
    bio: 'Chuyên khoa Nhi, tốt nghiệp Đại học Y Dược Thái Nguyên, hơn 10 năm kinh nghiệm khám và điều trị các bệnh lý thường gặp ở trẻ em, tư vấn dinh dưỡng và lịch tiêm chủng. Được nhiều phụ huynh tin tưởng nhờ sự nhẹ nhàng, kiên nhẫn khi khám cho trẻ nhỏ.',
  },
  {
    email: 'bs.le.van.cuong@ducminh.local',
    phone: '0912345673',
    bio: 'Hơn 12 năm kinh nghiệm trong lĩnh vực Tai – Mũi – Họng, từng tu nghiệp nội soi Tai Mũi Họng tại Bệnh viện Tai Mũi Họng Trung ương. Chuyên điều trị viêm xoang mãn tính, viêm amidan, viêm tai giữa ở cả người lớn và trẻ em.',
  },
  {
    email: 'bs.pham.thi.dung@ducminh.local',
    phone: '0912345674',
    bio: 'Chuyên khoa Da liễu với 9 năm kinh nghiệm điều trị mụn, nám, viêm da cơ địa và các bệnh lý da liễu thường gặp. Tốt nghiệp Đại học Y Dược TP.HCM, thường xuyên cập nhật các phác đồ điều trị da liễu mới.',
  },
  {
    email: 'bs.hoang.thi.em@ducminh.local',
    phone: '0912345675',
    bio: 'Hơn 14 năm kinh nghiệm trong lĩnh vực Sản phụ khoa, từng công tác tại Bệnh viện Phụ sản Trung ương. Chuyên khám thai định kỳ, siêu âm sản khoa, tư vấn kế hoạch hóa gia đình và khám phụ khoa tổng quát.',
  },
  {
    email: 'bs.vu.van.phuc@ducminh.local',
    phone: '0912345676',
    bio: 'Tốt nghiệp Đại học Y Dược Thái Nguyên chuyên ngành Răng – Hàm – Mặt, 8 năm kinh nghiệm khám và điều trị các bệnh lý răng miệng cơ bản, cạo vôi răng, nhổ răng tiểu phẫu và tư vấn chỉnh nha.',
  },
];

(async () => {
  for (const doc of DOCTOR_PROFILES) {
    const { rowCount } = await pool.query(
      `UPDATE users SET bio = $1, phone = $2 WHERE email = $3 AND role = 'doctor'`,
      [doc.bio, doc.phone, doc.email]
    );
    console.log(rowCount ? `Đã cập nhật: ${doc.email}` : `Không tìm thấy (bỏ qua): ${doc.email}`);
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
