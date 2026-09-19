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

const INVOICE_STATUSES = ['chua_thanh_toan', 'da_thanh_toan'];
const INVOICE_STATUS_LABELS = {
  chua_thanh_toan: 'Chưa thanh toán',
  da_thanh_toan: 'Đã thanh toán',
};

const GENDERS = ['nam', 'nu', 'khac'];
const GENDER_LABELS = { nam: 'Nam', nu: 'Nữ', khac: 'Khác' };

// Đối tượng ưu tiên khai lúc đặt lịch — bệnh nhân tự khai, nhân viên xác minh
// thẻ thật khi lập hoá đơn. Chỉ chọn được 1 loại, không cộng dồn nhiều ưu đãi.
const DISCOUNT_CATEGORIES = ['bhyt', 'sinh_vien'];
const DISCOUNT_CATEGORY_LABELS = {
  bhyt: 'Bảo hiểm y tế (BHYT)',
  sinh_vien: 'Thẻ sinh viên',
};

// Hình thức thanh toán hoá đơn — ghi nhận khi nhân viên xác nhận đã thu tiền.
const PAYMENT_METHODS = ['tien_mat', 'chuyen_khoan'];
const PAYMENT_METHOD_LABELS = { tien_mat: 'Tiền mặt', chuyen_khoan: 'Chuyển khoản' };

module.exports = {
  SPECIALTIES, APPOINTMENT_STATUSES, APPOINTMENT_STATUS_LABELS,
  INTERACTION_SEVERITIES, INTERACTION_SEVERITY_LABELS,
  INVOICE_STATUSES, INVOICE_STATUS_LABELS,
  GENDERS, GENDER_LABELS,
  PAYMENT_METHODS, PAYMENT_METHOD_LABELS,
  DISCOUNT_CATEGORIES, DISCOUNT_CATEGORY_LABELS,
};
