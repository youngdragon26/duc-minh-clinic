// Tham số mã trên URL (:id, :appointmentId) phải là số nguyên dương — nếu không,
// Number('abc') = NaN lọt xuống câu SQL và Postgres báo lỗi kiểu dữ liệu, người dùng
// nhận "lỗi máy chủ" 500 thay vì "không tìm thấy". Gắn bằng router.param(...) ở mỗi route.
function intParam(req, res, next, value) {
  if (!/^[1-9]\d{0,9}$/.test(value)) return res.status(404).json({ error: 'Không tìm thấy dữ liệu yêu cầu.' });
  next();
}

module.exports = { intParam };
