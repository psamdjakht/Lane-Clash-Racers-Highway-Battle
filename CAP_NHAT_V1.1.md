# CẬP NHẬT V1.1 – ĐƯỜNG ĐUA VÀ VA CHẠM

## Cách cập nhật nhanh trên GitHub

Chỉ cần ghi đè hai file:

- `js/game.js`
- `sw.js`

Không ghi đè `js/config.js` đang chứa Project URL và anon key Supabase của bạn.

Sau khi GitHub Pages triển khai xong:

1. Mở lại game.
2. Nhấn `Ctrl + F5` để tải lại bắt buộc.
3. Nếu vẫn thấy bản cũ, mở Chrome DevTools > Application > Service Workers > Unregister, sau đó tải lại trang một lần.

## Nội dung đã sửa

- Mặt đường thấp và rộng hơn, không còn cảm giác chạy lên trời.
- Xe bám đúng tâm làn, không trôi ngang vô định.
- Xe không còn xuyên hoặc đè hình lên nhau.
- Chuyển làn bị chặn nếu xe khác đang ở quá gần.
- Xe phía sau giữ khoảng cách với xe phía trước.
- Va chạm có giảm tốc, trả xe về làn và bất tử chớp thân xe.
- Đồng bộ xe online được nội suy để giảm giật hình.
