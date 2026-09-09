// Danh sách chuyên khoa cố định — khớp với 6 chuyên khoa hiển thị ở trang chủ.
// Đổi ở đây thì cũng phải đổi CHECK constraint tương ứng trong src/db.js.
const SPECIALTIES = [
  'Nội tổng quát',
  'Nhi khoa',
  'Tai – Mũi – Họng',
  'Da liễu',
  'Sản phụ khoa',
  'Răng – Hàm – Mặt',
];

// Vòng đời 1 lịch hẹn: chờ xác nhận -> đã xác nhận -> đã check-in -> đang khám -> hoàn thành
// (hoặc bị huỷ ở bất kỳ bước nào trước "đang khám").
const APPOINTMENT_STATUSES = [
  'cho_xac_nhan',
  'da_xac_nhan',
  'da_checkin',
  'dang_kham',
  'hoan_thanh',
  'da_huy',
];

const APPOINTMENT_STATUS_LABELS = {
  cho_xac_nhan: 'Chờ xác nhận',
  da_xac_nhan: 'Đã xác nhận',
  da_checkin: 'Đã check-in',
  dang_kham: 'Đang khám',
  hoan_thanh: 'Hoàn thành',
  da_huy: 'Đã huỷ',
};

const INTERACTION_SEVERITIES = ['nhe', 'trung_binh', 'nghiem_trong'];
const INTERACTION_SEVERITY_LABELS = {
  nhe: 'Nhẹ',
  trung_binh: 'Trung bình',
  nghiem_trong: 'Nghiêm trọng',
};

module.exports = {
  SPECIALTIES, APPOINTMENT_STATUSES, APPOINTMENT_STATUS_LABELS,
  INTERACTION_SEVERITIES, INTERACTION_SEVERITY_LABELS,
};
