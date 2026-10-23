# HanziDuel · 汉字对决

Web đấu từ vựng tiếng Trung **HSK 3.0** realtime, chạy trên **Cloudflare Workers** tại https://hanziduel.com.

Câu hỏi có 3 dạng, trộn ngẫu nhiên cả trong PvP lẫn luyện phản xạ:
- **Hán → Việt**: nhìn chữ Hán, chọn nghĩa tiếng Việt.
- **Việt → Hán**: nhìn nghĩa tiếng Việt, chọn chữ Hán.
- **Nghe → nghĩa**: nghe phát âm, chọn nghĩa tiếng Việt. Dạng này không phải "nghe → chọn chữ", vì chữ được đọc phải gửi xuống trình duyệt, nên nếu đáp án là chữ Hán thì người chơi tự thấy ngay đáp án. Máy nào không có giọng đọc tiếng Trung sẽ hiện pinyin thay thế.

Các chế độ chơi:
- **PvP xếp hạng**: ghép trận theo Elo. Mỗi trận 10 câu, mỗi câu 10 giây; đúng và nhanh thì được nhiều điểm hơn. Rank càng cao thì từ càng khó: Đồng chỉ có HSK 1, Đại Sư có đến HSK 7–9.
- **Mời bạn đấu giao hữu**: tạo link `hanziduel.com/?room=…`, có hiệu lực 15 phút. Trận giao hữu **không tính Elo**, để không ai tự mời tài khoản phụ của mình mà dồn điểm.
- **Bảng xếp hạng**: có hai bảng, **Tháng này** (số Elo kiếm được trong tháng, tự đặt lại đầu mỗi tháng theo giờ Việt Nam) và **Mọi thời đại**.
- **Chuỗi ngày**: đếm số ngày liên tiếp có chơi, tính cả PvP, luyện phản xạ và học từ. Không tính riêng PvP, vì lúc ít người online thì chuỗi sẽ đứt chỉ do không ghép được trận.
- **Luyện phản xạ 60 giây**: chọn cấp HSK, có chuỗi đúng liên tiếp và lưu kỷ lục, không ảnh hưởng rank.
- **Học từ mới**: thẻ lật có pinyin, nghĩa và phát âm. Tiến độ lưu theo tài khoản.
- **Ôn từ đã sai**: lưu những từ trả lời sai trong PvP và luyện phản xạ. Đánh dấu "Đã thuộc" thì từ đó được bỏ khỏi danh sách ôn.
- **Đăng nhập Google**, giao diện sáng/tối, chơi được trên điện thoại.

## Kiến trúc

```
trình duyệt ──HTTPS──▶ Worker (src/worker.js)
                        ├─ file tĩnh: public/  (Workers Assets)
                        └─ /ws ──WebSocket──▶ Durable Object "Game" (một bản duy nhất)
                                               ├─ src/core.js: đăng nhập, ghép trận, chấm điểm, học từ
                                               └─ SQLite có sẵn của Durable Object: players, sessions
```

- `src/core.js` chứa toàn bộ logic và không phụ thuộc Cloudflare, nên test chạy được ngay trong Node (`node:sqlite`).
- Server tự chấm điểm và tự tính giờ. Đáp án không bao giờ được gửi xuống trình duyệt trong lúc đang đấu.
- Token Google được xác minh bằng WebCrypto (`src/google.js`). Phiên đăng nhập chỉ lưu SHA-256 của token.
- Khi không có ai chơi, Durable Object tự "ngủ đông" và không tốn tài nguyên. Kết nối vẫn được giữ, và dữ liệu người chơi được khôi phục khi nó thức dậy.

## Chạy trên máy

```bash
npm install
npm run dev
```

Mở http://localhost:3000. Lệnh này chạy Worker và Durable Object thật trên máy (dữ liệu nằm trong `.wrangler/`).

- Có file `.dev.vars` chứa `GOOGLE_CLIENT_ID=""` thì web dùng **đăng nhập bằng tên**. Muốn thử PvP thì mở thêm một cửa sổ ẩn danh.
- Xoá file đó thì web dùng đăng nhập Google thật (`localhost:3000` đã được thêm vào Google Cloud).

| Lệnh | Việc |
|---|---|
| `npm test` | Test luật chơi, dữ liệu, xác minh token Google, tài khoản, trận PvP, lưu trữ |
| `npm run dev` | Chạy Worker trên máy, cổng 3000 |
| `npm run deploy` | Deploy thủ công. Bình thường không cần, vì push lên GitHub là tự deploy |
| `npm run words` | Tải lại và dựng `data/words.json` từ nguồn |

## Deploy

Worker `hanziduel` trên Cloudflare đã được nối với repo GitHub này, nên **mỗi lần push lên `main` là tự build và deploy**. Bạn theo dõi ở Cloudflare → Workers & Pages → hanziduel → Deployments.

- Domain: `hanziduel.com` (Custom domain) và `hanziduel.0xnothing-network.workers.dev`.
- Cấu hình nằm trong `wrangler.jsonc`. `GOOGLE_CLIENT_ID` là giá trị công khai (trình duyệt nào cũng nhận được), nên được ghi thẳng trong file.
- Không cần thêm biến môi trường hay secret nào trên Cloudflare.

### Google Sign-In

Project Google Cloud là `hanziduel`, OAuth client là "HanziDuel web", và ứng dụng đang ở trạng thái **In production**.
- Authorized JavaScript origins: `https://hanziduel.com`, `http://localhost`, `http://localhost:3000`.
- Nếu muốn đăng nhập được trên domain `*.workers.dev`, cần thêm domain đó vào danh sách origins.

### Xem và sao lưu dữ liệu

Dữ liệu nằm trong SQLite của Durable Object "Game". Bạn xem ở Cloudflare → Durable Objects → hanziduel_Game → Data Studio. Durable Object tự lưu lịch sử 30 ngày và có thể khôi phục về thời điểm cũ (point-in-time recovery).

```sql
SELECT json_extract(data, '$.name') AS ten, json_extract(data, '$.rating') AS elo
FROM players ORDER BY elo DESC LIMIT 10;
```

## Giới hạn đã biết

- **Chỉ có một Durable Object giữ toàn bộ game.** Cách này đơn giản và đủ cho giai đoạn đầu; tôi chưa đo tải nên chưa biết nó chịu được bao nhiêu người online cùng lúc. Khi quá tải thì tách ra theo khu vực hoặc theo dải rank.
- Deploy code mới thì các trận đang diễn ra sẽ bị huỷ. Dữ liệu đã lưu thì không mất.
- Thời gian trả lời đo ở phía server, nên người có ping cao bị chậm hơn vài chục ms.
- Kỷ lục luyện phản xạ chỉ lưu trên trình duyệt.
- Âm thanh phát âm dùng giọng đọc có sẵn của trình duyệt hoặc hệ điều hành; một số máy Windows cần cài thêm gói giọng tiếng Trung.

## Nguồn dữ liệu và giấy phép

| Dữ liệu | Nguồn | Giấy phép |
|---|---|---|
| Danh sách từ HSK 3.0, pinyin, nghĩa tiếng Anh | [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) | MIT |
| Nghĩa tiếng Việt | **CVDICT** của Phong Phan, dịch từ CC-CEDICT. Repo gốc `ph0ngp/CVDICT` đã offline nên dùng bản `CVDICT.u8` nguyên vẹn trong [phucbm/xue-hanzi](https://github.com/phucbm/xue-hanzi), cố định theo commit | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |

`npm run words` ghép hai nguồn theo **chữ + pinyin** để chọn đúng nghĩa khi một chữ có nhiều cách đọc. Có 42 trên 10.969 từ không có trong CVDICT; những từ này hiển thị nghĩa tiếng Anh.

**CC BY-SA 4.0 yêu cầu:**
- Ghi nguồn. Footer của web đã ghi sẵn, đừng xoá.
- File `data/words.json` phải được chia sẻ theo cùng giấy phép nếu bạn phân phối lại.

Code của game không bị ảnh hưởng.
