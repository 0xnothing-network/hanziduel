# HanziDuel · 汉字对决

Web đấu từ vựng tiếng Trung **HSK 3.0** realtime. Mọi câu hỏi đều theo dạng **Hán → Việt**: nhìn chữ Hán và chọn nghĩa tiếng Việt đúng.

- **PvP xếp hạng**:
  - Ghép trận theo Elo. Mỗi trận 10 câu, mỗi câu 10 giây; đúng và nhanh thì được nhiều điểm hơn.
  - Rank càng cao thì từ càng khó: Đồng chỉ có HSK 1, Đại Sư có đến HSK 7–9.
  - Có màn VS đếm ngược và dấu ✓ khi đối thủ đã trả lời.
- **Luyện phản xạ 60 giây**: chọn cấp HSK, có combo và lưu kỷ lục, không ảnh hưởng rank.
- **Học từ mới**: thẻ lật 3D, phát âm tiếng Trung, đánh dấu "đã thuộc". Tiến độ lưu theo tài khoản, có thanh tiến độ cho từng cấp.
- **Đăng nhập Google**, giao diện sáng/tối, chơi được trên điện thoại.
- **Hiệu ứng**: âm thanh (tắt/bật được), rung trên điện thoại, pháo giấy khi thắng.

## Chạy thử trên máy

```bash
npm install
npm start
```

Mở http://localhost:3000. Khi chưa đặt `GOOGLE_CLIENT_ID`, web chạy ở **chế độ dev**: đăng nhập chỉ bằng tên. Muốn thử PvP thì mở thêm một cửa sổ ẩn danh, đăng nhập bằng tên khác, rồi bấm "Tìm trận" ở cả hai.

| Lệnh | Việc |
|---|---|
| `npm test` | Chạy toàn bộ test: luật chơi, dữ liệu, HTTP, tài khoản, trận PvP, Postgres |
| `npm run words` | Tải lại và dựng `data/words.json` từ nguồn |

### Biến môi trường

Khi chạy local, `npm start` tự đọc file `.env` nếu có. File này đã nằm trong `.gitignore`, nên không bị commit. Ví dụ:

```
DATABASE_URL=postgresql://user:pass@host/db?sslmode=verify-full
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
```

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng web |
| `GOOGLE_CLIENT_ID` | (trống = chế độ dev) | Client ID của Google OAuth |
| `DATABASE_URL` | (trống = file JSON) | Chuỗi kết nối Postgres |
| `DB_FILE` | `data/db.json` | File dữ liệu khi không dùng Postgres |

---

## Cài đặt database

Web có hai cách lưu dữ liệu: người chơi, Elo, phiên đăng nhập và tiến độ học.

| | File JSON (mặc định) | **Postgres (khuyên dùng khi chạy thật)** |
|---|---|---|
| Cài đặt | Không cần làm gì | Cần một database Postgres |
| Hợp với | Chạy thử, ít người chơi | Từ vài chục người chơi trở lên |
| Sao lưu | Tự copy file | `pg_dump` hoặc nhà cung cấp tự sao lưu |

Cách server dùng database: toàn bộ dữ liệu được nạp vào RAM khi khởi động nên mọi thao tác đều nhanh. Thay đổi được ghi xuống database theo lô, mỗi giây một lần, còn kết quả trận đấu thì ghi ngay lập tức. **Bảng được tạo tự động** khi server khởi động lần đầu, bạn không cần chạy SQL.

### Cách A: Postgres miễn phí trên cloud (dễ nhất)

**Neon** (https://neon.tech), gói miễn phí đủ dùng:
1. Đăng ký và tạo project, chọn region **Singapore** cho gần Việt Nam.
2. Vào **Connection string** và copy chuỗi có dạng:
   `postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`

**Supabase** (https://supabase.com) cũng dùng được:
1. Tạo project, chọn region Singapore.
2. Vào **Project Settings → Database → Connection string**, chọn **Session pooler** (cổng 5432), rồi copy chuỗi và thay `[YOUR-PASSWORD]` bằng mật khẩu thật.

Thử trên máy (PowerShell):

```powershell
$env:DATABASE_URL="postgresql://...?sslmode=require"; npm start
```

Nếu dòng log có chữ `[postgres]` là đã kết nối được.

### Cách B: Tự cài Postgres trên VPS

```bash
sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE USER hanzi WITH PASSWORD 'doi-mat-khau-manh';"
sudo -u postgres psql -c "CREATE DATABASE hanziduel OWNER hanzi;"
```

Khi đó `DATABASE_URL=postgres://hanzi:doi-mat-khau-manh@localhost:5432/hanziduel`

Mặc định Postgres chỉ nghe ở localhost, đừng mở cổng 5432 ra internet.

Sao lưu mỗi đêm:

```bash
sudo -iu postgres crontab -e
# thêm dòng:
0 3 * * * pg_dump hanziduel | gzip > /var/backups/hanziduel-$(date +\%F).sql.gz
```

### Chuyển dữ liệu từ file JSON sang Postgres

Nếu đã có người chơi trong `data/db.json`:

```bash
DATABASE_URL="postgres://..." node migrate-to-postgres.js data/db.json
```

Script này chạy lại nhiều lần cũng không sao, vì nó chỉ ghi đè hoặc thêm, không xoá gì.

### Cấu trúc bảng

```sql
players  (id text PRIMARY KEY, data jsonb, updated_at timestamptz)  -- tên, Elo, thắng/thua, từ đã thuộc
sessions (token_hash text PRIMARY KEY, player_id text, created_at timestamptz)  -- chỉ lưu SHA-256 của token
```

Ví dụ xem top 10:

```sql
SELECT data->>'name' AS ten, (data->>'rating')::int AS elo FROM players ORDER BY elo DESC LIMIT 10;
```

---

## Đưa lên mạng (tên miền trên Cloudflare)

Game dùng WebSocket và phải có một server Node chạy liên tục, nên **không chạy được trên Cloudflare Pages hay Workers**. Cách gọn nhất là:

**1 VPS nhỏ + Cloudflare Tunnel.** Không cần mở cổng, không cần tự cài SSL, và WebSocket chạy được ngay.

### Bước 1: Tạo Google Client ID

1. Vào https://console.cloud.google.com và tạo project mới.
2. Vào **APIs & Services → OAuth consent screen**: chọn *External*, điền tên app và email, rồi **Publish app**.
3. Vào **Credentials → Create credentials → OAuth client ID** và chọn **Web application**:
   - **Authorized JavaScript origins**: thêm `https://tenmiencuaban.com`, `http://localhost` và `http://localhost:3000`
   - Không cần điền Redirect URI.
4. Copy **Client ID**.

### Bước 2: VPS và Node

Thuê một VPS Ubuntu 22.04/24.04, 1 vCPU và 1 GB RAM là đủ. Sau đó chạy:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs git
sudo useradd -m -s /bin/bash hanzi
sudo -iu hanzi
git clone <repo-cua-ban> app && cd app
npm ci --omit=dev
exit
```

### Bước 3: systemd

Tạo file `/etc/systemd/system/hanziduel.service`:

```ini
[Unit]
Description=HanziDuel
After=network.target postgresql.service

[Service]
User=hanzi
WorkingDirectory=/home/hanzi/app
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
Environment=DATABASE_URL=postgresql://...
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now hanziduel
curl -s localhost:3000/healthz     # in ra "ok" là được
journalctl -u hanziduel -f         # xem log
```

### Bước 4: Cloudflare Tunnel

1. Trên Cloudflare dashboard, mở **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**.
2. Chạy lệnh cài đặt mà Cloudflare đưa ra trên VPS.
3. Ở tab **Public Hostname**: domain `tenmiencuaban.com`, Service **HTTP** → `localhost:3000`.
4. Mở `https://tenmiencuaban.com`.

Khoá VPS lại, chỉ để mở SSH:

```bash
sudo ufw allow OpenSSH && sudo ufw enable
```

Có thể dùng `/healthz` cho các dịch vụ theo dõi uptime như UptimeRobot hay Cloudflare Health Checks.

### Cập nhật code

```bash
sudo -iu hanzi bash -c "cd app && git pull && npm ci --omit=dev"
sudo systemctl restart hanziduel
```

Khi khởi động lại, các trận đang diễn ra sẽ bị huỷ. Dữ liệu đã lưu thì không mất vì server ghi hết trước khi tắt.

---

## Hiệu năng và bảo mật

- Trang chỉ là **1 file HTML khoảng 14 KB** (nén brotli) cộng 15 KB socket.io. Không dùng framework, không có bước build.
- HTML được nén sẵn (brotli/gzip) và có ETag, nên lần truy cập sau chỉ nhận về 304 với 0 byte. Script Google chỉ được tải khi cần đăng nhập.
- Client thử WebSocket trước, nếu bị chặn thì tự chuyển sang long-polling.
- Server tự chấm điểm và tự tính giờ. Đáp án không bao giờ được gửi xuống trình duyệt trong lúc đang đấu.
- Token đăng nhập Google được xác minh ở server. Phiên đăng nhập chỉ lưu SHA-256 của token. Mỗi tin nhắn socket bị giới hạn 10 KB, và mọi dữ liệu người dùng gửi lên đều được kiểm tra.
- Mở tài khoản ở tab hoặc thiết bị mới thì tab cũ bị đăng xuất. Nếu đang trong trận thì bị tính là bỏ cuộc.

## Giới hạn đã biết

- **Chỉ chạy một server.** Hàng chờ ghép trận và trận đang đấu nằm trong RAM. Một VPS nhỏ đủ cho giai đoạn đầu, nhưng tôi chưa đo tải nên chưa biết chính xác bao nhiêu người online cùng lúc; muốn nhiều server hơn thì cần Redis adapter cho socket.io và chuyển trạng thái trận sang Redis.
- Thời gian trả lời đo ở phía server, nên người có ping cao bị chậm hơn vài chục ms.
- Kỷ lục luyện phản xạ chỉ lưu trên trình duyệt.
- Âm thanh phát âm dùng giọng đọc có sẵn của trình duyệt hoặc hệ điều hành; một số máy Windows cần cài thêm gói giọng tiếng Trung.

## Nguồn dữ liệu và giấy phép

| Dữ liệu | Nguồn | Giấy phép |
|---|---|---|
| Danh sách từ HSK 3.0, pinyin, nghĩa tiếng Anh | [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) | MIT |
| Nghĩa tiếng Việt | **CVDICT** của Phong Phan, dịch từ CC-CEDICT. Repo gốc `ph0ngp/CVDICT` đã offline nên dùng bản `CVDICT.u8` nguyên vẹn trong [phucbm/xue-hanzi](https://github.com/phucbm/xue-hanzi), cố định theo commit | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |

`npm run words` ghép hai nguồn theo **chữ + pinyin** để chọn đúng nghĩa khi một chữ có nhiều cách đọc. Ví dụ 了 lấy cách đọc le (trợ từ) chứ không lấy liǎo, và 说 lấy shuō chứ không lấy shuì. Script cũng bỏ các ghi chú lượng từ và các tham chiếu chéo trong từ điển. Có 42 trên 10.969 từ không có trong CVDICT, chủ yếu là cụm từ; những từ này hiển thị nghĩa tiếng Anh.

**CC BY-SA 4.0 yêu cầu:**
- Ghi nguồn. Footer của web đã ghi sẵn, đừng xoá.
- File `data/words.json` phải được chia sẻ theo cùng giấy phép nếu bạn phân phối lại.

Code của game không bị ảnh hưởng. Được phép dùng cho mục đích thương mại.

CVDICT phần lớn được dịch bằng máy rồi sửa thủ công, nên một số nghĩa có thể chưa sát.
