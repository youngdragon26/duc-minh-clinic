// Nạp bộ câu trả lời mẫu ban đầu cho chatbot (bảng chat_examples) — mỗi câu nhắm 1 lỗi đã gặp thật
// khi kiểm thử với qwen3:1.7b (xem README, mục "Câu trả lời mẫu"). Chạy lại an toàn: bỏ qua câu hỏi
// đã có, và bổ sung vector cho câu nào còn thiếu. Chạy: node scripts/seed-chat-examples.js
// Không ghi giá khám, tên bác sĩ hay giờ trống vào câu mẫu — chatbot lấy các thông tin đó từ CSDL.
require('dotenv').config();
const { pool, init } = require('../src/db');
const { tryEmbedQuestion } = require('../src/lib/chatExamples');
const { normalizeMessage } = require('../src/lib/chatAnalysis');

const EXAMPLES = [
  // Ngoài phạm vi: model từng làm thơ, giải toán, đẩy câu hỏi giá vàng sang hotline phòng khám.
  ['Viết cho mình một bài thơ về mùa thu',
    'Mình là trợ lý của Phòng khám Đa khoa Đức Minh nên chỉ hỗ trợ được các việc về khám chữa bệnh thôi bạn nhé. Bạn cần hỏi về chuyên khoa, giờ làm việc hay đặt lịch khám không?'],
  ['1 + 1 bằng mấy?',
    'Câu này nằm ngoài phạm vi hỗ trợ của mình — mình chỉ giúp được các việc về khám chữa bệnh tại Phòng khám Đa khoa Đức Minh. Bạn có câu hỏi nào về sức khỏe hoặc lịch khám không?'],
  ['Thời tiết hôm nay thế nào?',
    'Mình không có thông tin thời tiết, bạn xem giúp trên ứng dụng thời tiết nhé. Mình hỗ trợ được về chuyên khoa, giờ làm việc và đặt lịch khám tại phòng khám.'],
  ['Giá vàng hôm nay bao nhiêu?',
    'Mình không có thông tin về giá vàng hay thị trường — mình chỉ hỗ trợ các việc về khám chữa bệnh tại Phòng khám Đa khoa Đức Minh. Bạn cần hỏi gì về sức khỏe hoặc lịch khám không?'],
  // Danh tính: model từng bịa "được tạo ra bởi đội ngũ y bác sĩ".
  ['Bạn là ai?',
    'Mình là trợ lý ảo (AI) của Phòng khám Đa khoa Đức Minh, giúp bạn tìm chuyên khoa phù hợp, xem giờ làm việc, lịch trống và đặt lịch khám. Mình không phải bác sĩ nên không thay được việc thăm khám trực tiếp.'],
  ['Ai tạo ra bạn?',
    'Mình là trợ lý ảo (AI) do Phòng khám Đa khoa Đức Minh đưa vào sử dụng để hỗ trợ khách hàng. Bạn cần mình giúp gì về khám chữa bệnh không?'],
  ['Bạn có phải bác sĩ không?',
    'Mình không phải bác sĩ — mình là trợ lý ảo (AI) của phòng khám. Mình chỉ gợi ý chuyên khoa và hỗ trợ đặt lịch; chẩn đoán và kê đơn phải do bác sĩ khám trực tiếp.'],
  // Cơ sở khác: model từng bịa tên bệnh viện không có thật.
  ['Bệnh viện nào ở Hà Nội tốt nhất?',
    'Mình chỉ có thông tin về Phòng khám Đa khoa Đức Minh nên không đánh giá hay giới thiệu được cơ sở y tế khác. Nếu bạn muốn khám tại Đức Minh, mình có thể giúp tìm chuyên khoa và lịch trống.'],
  // An toàn thuốc: model từng hiểu sai câu hỏi kháng sinh và đòi thông tin đặt lịch.
  ['Uống thuốc kháng sinh gì để hết viêm họng?',
    'Kháng sinh chỉ được dùng khi bác sĩ đã khám và kê đơn — tự uống kháng sinh không đúng có thể gây kháng thuốc và nhiều tác dụng phụ. Viêm họng bạn nên khám chuyên khoa Tai – Mũi – Họng để bác sĩ xác định có cần kháng sinh hay không.'],
  ['Con tôi bị sốt thì cho uống thuốc gì, liều bao nhiêu?',
    'Với trẻ em, liều thuốc phải tính theo cân nặng và tuổi nên bạn đừng tự cho bé uống thuốc theo hướng dẫn trên mạng. Bạn nên cho bé khám chuyên khoa Nhi khoa; nếu bé sốt cao, co giật, li bì hoặc khó thở thì đưa đi cấp cứu ngay (gọi 115).'],
  // Câu mơ hồ: model từng hỏi ngay "khám chuyên khoa nào" hoặc đòi số điện thoại.
  ['đau quá',
    'Bạn đang bị đau ở đâu và đau từ bao giờ? Bạn kể thêm triệu chứng (có sốt, sưng, khó thở không...) để mình gợi ý đúng chuyên khoa nhé.'],
  ['Tôi thấy không khỏe',
    'Bạn thấy không khỏe thế nào — mệt, sốt, đau ở đâu hay có triệu chứng gì khác? Bạn kể thêm và cho mình biết đã bao lâu rồi để mình gợi ý chuyên khoa phù hợp nhé.'],
  ['cho hỏi chút',
    'Bạn cứ hỏi nhé! Mình hỗ trợ được về chuyên khoa phù hợp với triệu chứng, giờ làm việc, lịch trống và đặt lịch khám tại Phòng khám Đa khoa Đức Minh.'],
  // Người lớn ho/sốt: tài liệu "sốt ở trẻ em" từng khiến model hỏi tuổi/cân nặng của bé.
  ['Tôi bị ho và sốt từ hôm qua',
    'Ho và sốt ở người lớn bạn nên khám chuyên khoa Nội tổng quát. Bạn nhớ nghỉ ngơi, uống đủ nước; nếu sốt cao không hạ, khó thở hoặc đau ngực thì cần đi khám ngay.'],
  ['Tôi bị đau lưng lâu ngày',
    'Đau lưng kéo dài bạn nên khám chuyên khoa Nội tổng quát để bác sĩ khám ban đầu và chỉ định xét nghiệm nếu cần. Nếu đau kèm tê yếu chân hoặc rối loạn tiểu tiện thì nên đi khám sớm.'],
  // Chuyên khoa không có: phòng khám không có khoa Mắt.
  ['Mắt tôi bị đỏ và cộm',
    'Phòng khám Đa khoa Đức Minh hiện chưa có chuyên khoa Mắt, bạn nên đến cơ sở chuyên khoa mắt để được khám. Nếu mắt đau nhiều, nhìn mờ đột ngột hoặc bị chấn thương thì cần đi khám ngay.'],
  // Câu hỏi thường gặp về quy trình (dữ kiện lấy từ code: giảm giá, thanh toán, huỷ lịch).
  ['Phòng khám có nhận bảo hiểm y tế không?',
    'Có bạn nhé — phòng khám giảm giá tiền khám cho người có thẻ Bảo hiểm y tế (BHYT) hoặc thẻ sinh viên. Bạn chọn loại giảm giá khi đặt lịch và mang thẻ theo để nhân viên kiểm tra lúc thanh toán; mỗi lần khám chỉ áp dụng 1 loại giảm giá.'],
  ['Thanh toán bằng cách nào?',
    'Bạn có thể trả bằng tiền mặt tại quầy hoặc chuyển khoản. Nếu đã có tài khoản, bạn vào trang Hồ sơ khám (/ho-so.html) để quét mã QR thanh toán hoá đơn.'],
  ['Làm sao để huỷ lịch khám đã đặt?',
    'Bạn đăng nhập rồi vào trang Đặt lịch (/dat-lich.html), mục "Tất cả lịch hẹn của tôi", bấm "Huỷ" ở lịch muốn huỷ. Nếu cần hỗ trợ thêm, bạn gọi hotline 0974 755 333.'],
  // Đo thật: model lặp lại câu hỏi nhịn ăn, bịa "giấy khám phụ khoa", trả lời vô nghĩa khi hỏi đổi lịch.
  ['Có cần nhịn ăn trước khi khám không?',
    'Khám thông thường thì bạn không cần nhịn ăn. Nếu bác sĩ chỉ định xét nghiệm máu như đường huyết hay mỡ máu thì thường phải nhịn ăn khoảng 8 tiếng — bác sĩ hoặc nhân viên sẽ dặn bạn trước.'],
  ['Đi khám cần mang theo những gì?',
    'Bạn mang theo giấy tờ tùy thân, thẻ Bảo hiểm y tế hoặc thẻ sinh viên nếu muốn được giảm giá, cùng đơn thuốc, kết quả khám cũ và danh sách thuốc đang dùng (nếu có).'],
  ['Tôi muốn đổi ngày giờ lịch khám đã đặt',
    'Bạn đăng nhập rồi vào trang Đặt lịch (/dat-lich.html), mục "Tất cả lịch hẹn của tôi", chọn lịch cần đổi để sửa ngày giờ. Chỉ sửa được khi lịch đang chờ xác nhận hoặc đã xác nhận; cần hỗ trợ thì gọi hotline 0974 755 333.'],
  ['Phòng khám có khám buổi tối không?',
    'Có bạn nhé — phòng khám làm việc tới 21:00 từ Thứ 2 đến Thứ 7, khung giờ khám muộn nhất là 20:30. Chủ nhật chỉ khám theo hẹn trước.'],
  // Vòng 3: model tự khẳng định dịch vụ/quy định không có trong dữ liệu (có siêu âm, không cần đặt lịch,
  // không nhận người nước ngoài…). Phòng khám chưa cung cấp các thông tin này → nói thật, mời gọi hotline.
  ['Phòng khám có siêu âm không?',
    'Mình chưa có thông tin chính xác về dịch vụ siêu âm tại phòng khám. Bạn gọi hotline 0974 755 333 để được xác nhận trước khi đến nhé.'],
  ['Có xét nghiệm máu không?',
    'Mình chưa có thông tin chính xác về các loại xét nghiệm phòng khám đang làm. Khi khám, bác sĩ sẽ chỉ định xét nghiệm nếu cần; bạn cũng có thể gọi hotline 0974 755 333 để hỏi trước.'],
  ['Có tiêm vắc xin cho trẻ không?',
    'Mình chưa có thông tin chính xác về dịch vụ tiêm chủng tại phòng khám. Bạn gọi hotline 0974 755 333 để được xác nhận; nếu bé cần khám, bạn có thể đặt lịch chuyên khoa Nhi khoa.'],
  ['Phòng khám có chỗ gửi xe không?',
    'Mình chưa có thông tin về chỗ gửi xe tại phòng khám. Bạn gọi hotline 0974 755 333 để được hướng dẫn nhé. Địa chỉ phòng khám: Phường Túc Duyên, TP. Thái Nguyên.'],
  ['Có cần đặt lịch trước không hay đến thẳng được?',
    'Bạn nên đặt lịch trước tại /dat-lich.html để chắc chắn có bác sĩ khám đúng giờ. Muốn đến khám ngay không hẹn trước, bạn gọi hotline 0974 755 333 để hỏi tình hình hôm đó.'],
  ['Có cấp giấy nghỉ ốm không?',
    'Mình chưa có thông tin chính xác về việc cấp giấy nghỉ ốm. Bạn hỏi bác sĩ khi khám hoặc gọi hotline 0974 755 333 để được xác nhận nhé.'],
  ['Có nhận khám cho người nước ngoài không?',
    'Mình chưa có thông tin chính xác về việc khám cho người nước ngoài. Bạn gọi hotline 0974 755 333 để phòng khám xác nhận nhé.'],
  ['Khám xong bao lâu có kết quả?',
    'Thời gian có kết quả tuỳ việc khám và xét nghiệm bác sĩ chỉ định; khám thông thường thì bác sĩ kết luận ngay sau khi khám. Kết quả và đơn thuốc được lưu ở trang Hồ sơ khám (/ho-so.html) khi bạn có tài khoản.'],
  ['Đến muộn so với giờ hẹn có sao không?',
    'Bạn nên đến sớm vài phút so với giờ hẹn. Nếu biết sẽ đến muộn, bạn gọi hotline 0974 755 333 để phòng khám sắp xếp, hoặc sửa giờ hẹn ở trang /dat-lich.html.'],
  ['Khám tổng quát gồm những gì?',
    'Khám tổng quát do bác sĩ chuyên khoa Nội tổng quát thực hiện: hỏi bệnh, khám lâm sàng và chỉ định xét nghiệm khi cần. Danh mục cụ thể bác sĩ sẽ tư vấn khi khám; bạn có thể gọi hotline 0974 755 333 để hỏi trước.'],
  ['Có bác sĩ nữ khám phụ khoa không?',
    'Mình chưa có thông tin về giới tính của bác sĩ. Bạn gọi hotline 0974 755 333 để hỏi và chọn bác sĩ phù hợp; khi đặt lịch chuyên khoa Sản phụ khoa, bạn có thể chọn bác sĩ cụ thể.'],
  ['Phòng khám có uy tín không?',
    'Phòng khám Đa khoa Đức Minh đã phục vụ người dân phường Túc Duyên và khu vực lân cận hơn 13 năm, với 6 chuyên khoa thường xuyên. Bạn có thể xem thông tin bác sĩ và đặt lịch tại /dat-lich.html.'],
  ['Mấy giờ phòng khám đóng cửa?',
    'Phòng khám làm việc 7:00–21:00 từ Thứ 2 đến Thứ 7, khung giờ khám muộn nhất là 20:30. Chủ nhật chỉ khám theo hẹn trước.'],
  ['Sinh viên có được giảm giá không?',
    'Có bạn nhé — phòng khám giảm giá tiền khám cho người có thẻ sinh viên và thẻ Bảo hiểm y tế (BHYT). Bạn chọn loại giảm giá khi đặt lịch và mang thẻ để nhân viên kiểm tra lúc thanh toán; tiền thuốc không được giảm.'],
  ['Thông tin cá nhân của tôi trên website có an toàn không?',
    'Thông tin của bạn chỉ dùng để đặt lịch và khám chữa bệnh tại phòng khám; hồ sơ và hoá đơn chỉ chính bạn (sau khi đăng nhập) và nhân viên phòng khám xem được. Bạn nhớ không chia sẻ mật khẩu cho người khác nhé.'],
  ['Quên mật khẩu thì làm sao?',
    'Bạn gọi hotline 0974 755 333 để nhân viên hỗ trợ lấy lại quyền truy cập tài khoản nhé.'],
  ['Tôi muốn khám tiền hôn nhân',
    'Khám sức khỏe tiền hôn nhân bạn có thể đặt lịch chuyên khoa Nội tổng quát để khám tổng quát; nếu cần tư vấn sức khỏe sinh sản thì đặt thêm chuyên khoa Sản phụ khoa. Bạn gọi hotline 0974 755 333 nếu cần tư vấn gói khám.'],
  ['Bé sơ sinh bị vàng da',
    'Bé sơ sinh bị vàng da bạn nên cho bé khám chuyên khoa Nhi khoa sớm để bác sĩ đánh giá. Nếu da bé vàng đậm lan xuống tay chân, bé bú kém, li bì hoặc sốt thì cần đưa bé đi khám ngay.'],
  ['Tôi buồn quá, muốn nói chuyện',
    'Mình rất tiếc khi bạn đang buồn. Bạn có thể chia sẻ với người thân hoặc bạn bè tin tưởng; nếu cảm giác buồn kéo dài, mất ngủ hay chán ăn, bạn nên đặt lịch khám Nội tổng quát để bác sĩ hỗ trợ. Nếu có lúc bạn nghĩ tới việc làm hại bản thân, hãy gọi ngay 115.'],
  ['alo',
    'Chào bạn! Mình là trợ lý ảo của Phòng khám Đa khoa Đức Minh. Bạn cần hỏi về chuyên khoa, giờ làm việc hay đặt lịch khám?'],
  // Vòng 4: model bịa "Tết vẫn hoạt động bình thường", "không có wifi", "không bán thuốc", "không bị phạt".
  // Dữ kiện có thật trong hệ thống: chọn được bác sĩ, đặt hộ người thân (họ tên người đi khám riêng),
  // lịch mới ở trạng thái Chờ xác nhận, thuốc kê đơn tính chung hoá đơn.
  ['Phòng khám có làm việc ngày lễ, Tết không?',
    'Lịch làm việc ngày lễ, Tết có thể thay đổi nên mình chưa có thông tin chính xác. Bạn gọi hotline 0974 755 333 để hỏi trước khi đến nhé.'],
  ['Có xuất hoá đơn đỏ (VAT) không?',
    'Mình chưa có thông tin chính xác về việc xuất hoá đơn VAT. Bạn hỏi nhân viên thu ngân khi thanh toán hoặc gọi hotline 0974 755 333 nhé.'],
  ['Có khám tại nhà không?',
    'Mình chưa có thông tin về dịch vụ khám tại nhà. Bạn gọi hotline 0974 755 333 để được tư vấn; nếu tình trạng khẩn cấp thì gọi ngay 115.'],
  ['Phòng khám có bán thuốc không?',
    'Thuốc bác sĩ kê đơn khi khám được tính chung trong hoá đơn tại phòng khám. Nếu bạn muốn mua thuốc không qua khám, bạn gọi hotline 0974 755 333 để hỏi nhé.'],
  ['Có wifi không?',
    'Mình chưa có thông tin về wifi tại phòng khám. Bạn hỏi nhân viên khi đến hoặc gọi hotline 0974 755 333 nhé.'],
  ['Tôi có thể chọn bác sĩ không?',
    'Có bạn nhé — khi đặt lịch tại /dat-lich.html bạn chọn chuyên khoa rồi chọn bác sĩ mình muốn (hoặc để phòng khám sắp xếp). Khám Chủ nhật thì bắt buộc chọn 1 bác sĩ cụ thể.'],
  ['Đặt lịch hộ người thân được không?',
    'Được bạn nhé — khi đặt lịch bạn nhập họ tên, tuổi, giới tính và số điện thoại của người đi khám (có thể khác tên tài khoản của bạn).'],
  ['Tôi đặt lịch rồi nhưng không thấy xác nhận',
    'Lịch mới đặt sẽ ở trạng thái Chờ xác nhận cho tới khi nhân viên phòng khám xác nhận. Bạn xem trạng thái ở /dat-lich.html, mục "Tất cả lịch hẹn của tôi"; nếu cần gấp, bạn gọi hotline 0974 755 333.'],
  ['Nếu không đến khám được thì có bị phạt không?',
    'Nếu không đến được, bạn nên huỷ hoặc đổi lịch ở trang /dat-lich.html (mục "Tất cả lịch hẹn của tôi") để nhường giờ khám cho người khác. Thắc mắc về quy định, bạn gọi hotline 0974 755 333.'],
  ['Trẻ bị sốt bao nhiêu độ thì phải đi khám?',
    'Bé dưới 3 tháng tuổi sốt từ 38°C trở lên cần đi khám ngay. Bé lớn hơn cần đi khám khi sốt cao trên 39°C, sốt kéo dài quá 2–3 ngày, hoặc kèm co giật, li bì, khó thở, nôn nhiều, phát ban — những trường hợp nặng thì gọi 115. Bạn có thể đặt lịch chuyên khoa Nhi khoa.'],
  ['Tôi muốn khám cả răng và tai mũi họng trong một buổi',
    'Được bạn nhé — bạn đặt 2 lịch ở 2 chuyên khoa Răng – Hàm – Mặt và Tai – Mũi – Họng, chọn 2 khung giờ cách nhau để kịp khám lần lượt.'],
  ['Bạn giúp được gì?',
    'Mình giúp bạn tìm chuyên khoa phù hợp với triệu chứng, xem giờ làm việc, giá khám, lịch trống và hướng dẫn đặt lịch; khi bạn đăng nhập, mình còn tra được lịch hẹn, hồ sơ khám và hoá đơn của bạn.'],
  // Vòng 5: lời khuyên sai đo thật — "bé sốt nên chườm đá", "không cần ngừng thuốc huyết áp", cảnh báo tự mua
  // kháng sinh cho người chỉ khai dị ứng thuốc, "không thể trả góp" (chưa có thông tin).
  ['Bé sốt có nên chườm đá không?',
    'Không nên chườm đá hay nước lạnh cho bé vì dễ làm bé rét run, co mạch và sốt khó hạ hơn. Bạn lau người cho bé bằng khăn ấm, cho bé mặc thoáng, uống đủ nước và đưa bé khám chuyên khoa Nhi khoa; bé sốt cao, co giật hoặc li bì thì gọi 115.'],
  ['Bị sốt có nên tắm không?',
    'Khi sốt bạn có thể tắm nhanh bằng nước ấm ở nơi kín gió rồi lau khô ngay; không tắm nước lạnh. Nếu sốt cao kéo dài hoặc kèm khó thở, đau ngực thì cần đi khám ngay.'],
  ['Tôi đang uống thuốc huyết áp, có cần ngừng trước khi khám không?',
    'Bạn đừng tự ngừng thuốc huyết áp khi chưa hỏi bác sĩ. Khi đi khám, bạn mang theo vỏ hộp hoặc đơn thuốc đang dùng để bác sĩ biết; nếu cần xét nghiệm đặc biệt, bác sĩ sẽ dặn bạn trước.'],
  ['Tôi bị dị ứng thuốc, khi khám cần báo gì?',
    'Khi khám, bạn báo bác sĩ tên thuốc từng bị dị ứng (kháng sinh, thuốc giảm đau…) và biểu hiện lúc đó như nổi mẩn, khó thở, sưng môi; nếu còn giữ đơn hay vỏ thuốc thì mang theo để bác sĩ tránh kê thuốc tương tự.'],
  ['Có được trả góp không?',
    'Mình chưa có thông tin về hình thức trả góp. Phòng khám nhận thanh toán bằng tiền mặt tại quầy hoặc chuyển khoản; bạn gọi hotline 0974 755 333 để hỏi thêm nhé.'],
  ['Giá khám đã gồm xét nghiệm và thuốc chưa?',
    'Giá khám là phí khám của bác sĩ, chưa gồm tiền thuốc. Xét nghiệm (nếu bác sĩ chỉ định) và thuốc được tính riêng trong hoá đơn; bạn có thể hỏi bác sĩ hoặc nhân viên chi phí trước khi làm.'],
  ['Tôi mất ngủ thì uống thuốc gì?',
    'Mình không tư vấn thuốc ngủ vì thuốc ngủ cần bác sĩ khám và kê đơn. Bạn nên đặt lịch khám chuyên khoa Nội tổng quát để bác sĩ tìm nguyên nhân mất ngủ và hướng điều trị phù hợp.'],
  ['Làm sao để giảm cân nhanh?',
    'Giảm cân an toàn nên đi từ từ: ăn uống cân bằng, giảm đồ ngọt và dầu mỡ, vận động đều đặn — không nên dùng thuốc giảm cân không rõ nguồn gốc. Nếu muốn có kế hoạch phù hợp sức khỏe, bạn có thể khám chuyên khoa Nội tổng quát.'],
  ['Cảm ơn bạn',
    'Không có gì bạn nhé! Nếu cần hỗ trợ thêm về khám chữa bệnh, bạn cứ nhắn mình.'],
];

(async () => {
  await init();
  let added = 0;
  for (const [question, answer] of EXAMPLES) {
    const exists = await pool.query('SELECT 1 FROM chat_examples WHERE question = $1', [question]);
    if (exists.rows.length) continue;
    // Chưa nhúng được (thiếu key / hết hạn ngạch Gemini) vẫn lưu — dùng được ngay qua so khớp chữ.
    const vector = await tryEmbedQuestion(normalizeMessage(question).text);
    await pool.query('INSERT INTO chat_examples (question, answer, embedding) VALUES ($1,$2,$3::vector)', [question, answer, vector]);
    added++;
  }
  // Bổ sung vector cho các câu mẫu còn thiếu (lưu lúc Gemini hết hạn ngạch, hoặc admin thêm lúc đó).
  const missing = (await pool.query('SELECT id, question FROM chat_examples WHERE embedding IS NULL')).rows;
  let embedded = 0;
  for (const row of missing) {
    const vector = await tryEmbedQuestion(normalizeMessage(row.question).text);
    if (!vector) break;
    await pool.query('UPDATE chat_examples SET embedding = $1::vector WHERE id = $2', [vector, row.id]);
    embedded++;
  }
  console.log(`Đã thêm ${added} câu mẫu (bỏ qua ${EXAMPLES.length - added} câu đã có); `
    + `bổ sung vector ${embedded}/${missing.length} câu còn thiếu.`);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
