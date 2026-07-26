# Cập nhật Lane Clash Racers v1.3

## Mục tiêu

Đưa góc nhìn đường và xe về gần phong cách Highway Racer/OutRun: mặt đường nằm tự nhiên, có cua, xe hướng đúng theo làn, va chạm xảy ra tại mũi xe và vật thể bám tuyệt đối vào chuyển động của đường.

## Nội dung đã sửa

1. **Đường cua pseudo-3D**
   - Đường được dựng từ tọa độ thế giới theo khoảng cách `z`.
   - Các đoạn cua trái/phải được tạo bằng hàm cong liên tục và xác định từ seed của phòng.
   - Camera tự căn theo tiếp tuyến ngay tại xe người chơi để xe không có cảm giác trôi ngang.

2. **Một hệ tọa độ duy nhất**
   - Vạch làn, xe, vàng, power-up và chướng ngại cùng gọi một hàm chiếu.
   - Không còn tình trạng vạch đường chạy nhanh nhưng vật thể trôi chậm hoặc lệch khỏi mặt đường.

3. **Hướng xe**
   - Xe đối thủ xoay theo hướng đường tại đúng vị trí của xe.
   - Xe người chơi thẳng theo camera khi giữ làn và chỉ nghiêng khi chuyển làn.
   - Dùng sprite nhìn từ sau thuộc Kenney Racing Kit CC0.

4. **Va chạm tại mũi xe**
   - Xác định vị trí mũi xe theo kích thước sprite thực tế.
   - Khi đáy vật cản vừa chạm mũi xe, va chạm được kích hoạt ngay.
   - Không còn phải chờ vật thể lọt vào giữa thân xe.

5. **Cảm giác tốc độ**
   - Tốc độ nền tăng từ khoảng 70–108 lên 104–166 đơn vị thế giới/giây.
   - Gia tốc phản hồi nhanh hơn.
   - Tốc độ tối đa khi boost được mở rộng.
   - Chiều dài cuộc đua tăng tương ứng để thời lượng phòng không bị rút ngắn quá nhiều.

## Tệp cần ghi đè khi cập nhật

- `js/game.js`
- `sw.js`
- Thư mục `assets/cars/perspective/`

Sau khi cập nhật GitHub Pages, nhấn `Ctrl + F5`. Nếu vẫn còn bản cũ, xóa Service Worker hoặc dữ liệu trang rồi tải lại.
