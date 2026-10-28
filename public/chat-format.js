// Hiển thị câu trả lời của AI trong khung chat: mô hình hay trả về markdown đơn giản
// (**đậm**, "### tiêu đề", "* " đầu dòng) — nếu gán thẳng textContent sẽ thấy nguyên dấu **.
// Escape toàn bộ HTML trước rồi mới đổi **…** thành <strong>, nên không chèn được thẻ lạ (XSS).
// Dùng chung cho khung chat trang chủ (index.html) và trợ lý AI (khong-gian.html).
(function () {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatChatText(text) {
    return esc(text)
      .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>')
      .replace(/^(\s*)\*\s+/gm, '$1• ')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  window.setChatText = function (el, text) {
    el.innerHTML = formatChatText(text);
  };
})();
