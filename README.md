# KordCord — App chat giống Discord

Chat cùng bạn bè: server riêng, kênh text, kênh voice (WebRTC), tin nhắn realtime, link mời.

## Tính năng

- Đăng ký / đăng nhập (mật khẩu băm scrypt, token HMAC 7 ngày)
- Tạo server — tự có sẵn 2 kênh text (`#chung`, `#thong-bao`) + 2 kênh voice
- Tạo thêm kênh text / voice, tên kênh text tự chuyển không dấu (`Kênh Mới` → `#kenh-moi`)
- Nhắn tin realtime (Socket.io), báo "đang nhập...", danh sách thành viên + trạng thái online
- Kênh voice: bấm vào kênh voice → cho phép micro → nói chuyện mesh WebRTC, tắt mic / rời kênh
- **Link mời**: nút `+ Mời` trong server → link dạng `/invite/xxxxxxxx` → gửi bạn bè,
  họ mở link → đăng ký/đăng nhập → tự vào server. Chủ server thu hồi được link cũ.
- **Chế độ khách (guest)**: mở link mời → chỉ cần gõ tên hiển thị → vào server ngay,
  không cần tài khoản/email/mật khẩu. Khách chat + voice được, có nhãn `KHÁCH` ở
  danh sách thành viên và cạnh tên khi nhắn tin. Khách **không** tạo được server/kênh/link mời.
  Chủ server bật/tắt chế độ khách ngay trong hộp thoại `+ Mời` (mặc định: bật).
- Người chưa là thành viên không xem được kênh/tin nhắn (403)

## Chạy thử ở máy nhà

```bash
npm install
npm start
# mở http://localhost:3000
```

Kiểm tra tự động toàn bộ luồng (2 người dùng, mời, chat realtime, thu hồi link):

```bash
npm install --no-save socket.io-client
npm test
```

## Deploy lên Render (miễn phí)

1. Đẩy thư mục này lên một repo GitHub mới, ví dụ `KhangHoang007/kordcord`
   (toàn bộ file ở thư mục gốc của repo, gồm `package.json`, `server.js`, `render.yaml`, thư mục `public/`).
2. Vào https://render.com → đăng nhập bằng GitHub → **New + → Web Service** → chọn repo `kordcord`.
3. Nếu Render không tự nạp `render.yaml`, điền tay:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
   - Environment: thêm `APP_SECRET` = một chuỗi bí mật dài bất kỳ (đừng đổi sau khi đã có người đăng ký,
     đổi là mọi người bị đăng xuất).
4. Bấm **Create Web Service**, đợi 2–5 phút → được link dạng `https://kordcord.onrender.com`.
5. Mở link, đăng ký tài khoản đầu tiên, tạo server, bấm **+ Mời** → chép link mời gửi bạn bè.

### Lưu ý gói Free của Render

- Server **ngủ sau ~15 phút** không ai dùng; người đầu tiên mở lại phải chờ 30–60 giây để server thức.
- Ổ đĩa gói Free **không bền**: dữ liệu (`data/data.json`) có thể mất khi Render redeploy/restart.
  Bản này phù hợp cho nhóm bạn nhỏ thử nghiệm. Khi cần dữ liệu bền vững lâu dài, nâng cấp bước tiếp theo:
  chuyển storage sang Postgres (Supabase free) — cấu trúc code đã tách riêng ở các hàm `loadDb/saveDb` trong `server.js`.
- Voice dùng STUN công khai của Google; mạng nào chặn UDP/NAT khó có thể cần thêm TURN server.

## Cấu trúc

```
server.js          Backend: API + Socket.io + signalling voice
public/index.html  Giao diện Discord (1 file, không cần build)
render.yaml        Cấu hình Render
test-e2e.js        Test tự động 39 mục (gồm cả chế độ khách)
data/data.json     Dữ liệu (tự sinh khi chạy, đã gitignore)
```
