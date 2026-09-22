const express = require('express');
const ExcelJS = require('exceljs');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { normalizeRange, revenueSeries, specialtySeries, totals } = require('../lib/stats');

const router = express.Router();
router.use(authenticate, requireAdmin);

// GET /api/stats?group=day|month&from=YYYY-MM-DD&to=YYYY-MM-DD
// Mặc định: theo ngày trong 30 ngày gần nhất; theo tháng thì 12 tháng gần nhất.
router.get('/', async (req, res) => {
  try {
    const group = req.query.group === 'month' ? 'month' : 'day';
    const range = normalizeRange(req.query.from, req.query.to, group === 'month' ? 365 : 30);
    const [revenue, specialties, summary] = await Promise.all([
      revenueSeries({ ...range, group }),
      specialtySeries(range),
      totals(range),
    ]);
    res.json({ group, ...range, summary, revenue, specialties });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// UC013: xuất báo cáo thống kê ra file Excel thật (.xlsx, không phải CSV) — cùng
// tham số group/from/to với GET / ở trên, để file xuất ra luôn khớp đúng khoảng
// đang xem trên màn hình admin.
router.get('/export.xlsx', async (req, res) => {
  try {
    const group = req.query.group === 'month' ? 'month' : 'day';
    const range = normalizeRange(req.query.from, req.query.to, group === 'month' ? 365 : 30);
    const [revenue, specialties, summary] = await Promise.all([
      revenueSeries({ ...range, group }),
      specialtySeries(range),
      totals(range),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Đa Khoa Đức Minh';
    workbook.created = new Date();

    const overview = workbook.addWorksheet('Tổng quan');
    overview.columns = [
      { header: 'Chỉ số', key: 'k', width: 34 },
      { header: 'Giá trị', key: 'v', width: 22 },
    ];
    overview.addRows([
      { k: 'Khoảng thời gian báo cáo', v: `${range.from} → ${range.to}` },
      { k: 'Doanh thu đã thu (đ)', v: summary.revenue },
      { k: 'Số hoá đơn đã thu', v: summary.paidInvoices },
      { k: 'Công nợ chưa thu, toàn hệ thống (đ)', v: summary.unpaidAmount },
      { k: 'Số hoá đơn chưa thu, toàn hệ thống', v: summary.unpaidInvoices },
      { k: 'Số lịch hẹn trong khoảng', v: summary.appointments },
    ]);
    overview.getRow(1).font = { bold: true };
    overview.getCell('B2').numFmt = '#,##0';
    overview.getCell('B4').numFmt = '#,##0';

    const revSheet = workbook.addWorksheet(group === 'month' ? 'Doanh thu theo tháng' : 'Doanh thu theo ngày');
    revSheet.columns = [
      { header: group === 'month' ? 'Tháng' : 'Ngày', key: 'period', width: 14 },
      { header: 'Số hoá đơn', key: 'invoices', width: 14 },
      { header: 'Doanh thu (đ)', key: 'total', width: 18 },
    ];
    revSheet.addRows(revenue);
    revSheet.getRow(1).font = { bold: true };
    revSheet.getColumn('total').numFmt = '#,##0';

    const specSheet = workbook.addWorksheet('Theo chuyên khoa');
    specSheet.columns = [
      { header: 'Chuyên khoa', key: 'specialty', width: 26 },
      { header: 'Tổng lịch hẹn', key: 'total', width: 14 },
      { header: 'Hoàn thành', key: 'completed', width: 14 },
      { header: 'Đã huỷ', key: 'cancelled', width: 14 },
    ];
    specSheet.addRows(specialties);
    specSheet.getRow(1).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bao-cao-thong-ke_${range.from}_${range.to}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

module.exports = router;
