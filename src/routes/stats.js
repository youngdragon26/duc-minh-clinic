const express = require('express');
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

module.exports = router;
