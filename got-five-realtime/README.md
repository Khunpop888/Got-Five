# GOT FIVE! Realtime Prototype

เว็บเกม GOT FIVE! แบบ real-time ผ่าน WebSocket โดยไม่ต้องติดตั้ง package เพิ่ม ใช้ Python standard library สำหรับ backend และ HTML/CSS/JS ฝั่ง frontend

## สิ่งที่ทำไว้

- Lobby สร้างห้อง, เข้าห้องด้วยรหัส, copy invite link, ตั้งชื่อ, เลือกสีประจำตัว, จำกัด 2-4 คน
- เพิ่ม/ลบ Bot สำหรับทดสอบเกมคนเดียวในเครื่อง
- Backend เป็น authoritative state: deck, tile ลับ, turn, action, ranking อยู่บน server
- ส่ง state แยกตามผู้เล่น: เจ้าของไทล์จะเห็นเฉพาะช่อง/สี แต่ไม่เห็น `id`, `num`, หรือ `dots` ของไทล์ตัวเอง
- Real-time sync ด้วย WebSocket, chat สด, reconnect ด้วย session token ใน `localStorage`
- สุ่มผู้เล่นเริ่มเกมบน server ทุกแมตช์ ไม่ล็อกที่เจ้าของห้องหรือผู้เล่นคนแรก
- Private Board 1-60 สำหรับขีดฆ่าตัวเลขแบบส่วนตัว
- Categorise และ Compare พร้อม animation/highlight
- Post-match statistics: ranking, เวลา, จำนวนเทิร์น, action count, compare yes/no, จำนวนครั้ง/ความแม่นยำในการทาย
- Layout rack คู่แข่งแก้ให้มีพื้นที่สำหรับ compare tiles และ scroll แนวนอนบนจอเล็ก

## จุดบกพร่องหลักในไฟล์เดิม

- State ทั้งหมดอยู่ใน browser เดียว ถ้าทำออนไลน์ต่อทันทีผู้เล่นจะอ่านเลขลับตัวเองจาก DevTools ได้
- ไม่มี server authority สำหรับ validate turn/action ทำให้ client ปลอม action หรือแก้ state เองได้
- Bot logic เรียก `autoCategorise()` และ `autoCompare()` แต่ไม่มีฟังก์ชันจริงในไฟล์
- Chat และ log ใช้ `innerHTML` กับข้อมูล dynamic เสี่ยง XSS เมื่อเปิดเป็น multiplayer
- Lobby ยังเป็น offline setup ไม่มี room code, reconnect, invite link, หรือ profile color
- Layout compare ของ rack คู่แข่งใช้ absolute positioning ที่หลุด/โดนตัดเมื่อพื้นที่แคบหรือ compare หลายใบ
- Post-match stats ยังมีแค่ภาพรวม action ratio ยังไม่มี ranking/time/accuracy รายคนครบ

## วิธีรัน

1. เปิด PowerShell ที่โฟลเดอร์โปรเจกต์นี้

   ```powershell
   cd C:\Users\napon.su\Documents\Codex\2026-08-10\role-act-as-an-expert-full\outputs\got-five-realtime
   ```

2. รัน server

   ```powershell
   python server.py
   ```

3. เปิด browser ไปที่

   ```text
   http://127.0.0.1:8787
   ```

4. กดสร้างห้อง แล้ว copy invite link ส่งให้เพื่อน

## เล่นผ่านมือถือใน Wi-Fi เดียวกัน

1. หา IP ของเครื่อง PC

   ```powershell
   ipconfig
   ```

2. รัน server แบบเปิดรับเครื่องอื่น

   ```powershell
   $env:GOT_FIVE_HOST="0.0.0.0"; python server.py
   ```

3. มือถือเปิด URL นี้ โดยเปลี่ยน `<PC-IP>` เป็น IP จริงของเครื่อง

   ```text
   http://<PC-IP>:8787
   ```

## รัน Test

```powershell
python -m unittest discover -s tests
```

## โครงสร้างไฟล์

```text
got-five-realtime/
  server.py
  public/
    index.html
    styles.css
    app.js
    assets/
      got-five-product.jpg
  tests/
    test_game_engine.py
```

## หมายเหตุสำหรับเวอร์ชันออนไลน์จริง

Prototype นี้ใช้ native WebSocket เพื่อให้รันได้ทันทีโดยไม่ต้องพึ่ง Node/npm ในเครื่องนี้ ถ้าจะ deploy production แนะนำแยกเป็น Node + Socket.io หรือ ASGI backend, เพิ่ม HTTPS, rate limit, persistent room store, server-side auth, และ TURN/STUN ไม่จำเป็นสำหรับ WebSocket แต่ต้องมี reverse proxy ที่รองรับ upgrade header

## โปรไฟล์และรูปผู้เล่น

- หน้าเริ่มเกมและ Lobby เลือกชื่อ, สีประจำตัว และรูปโปรไฟล์ได้
- รูปโปรไฟล์ถูกย่อใน browser ก่อนส่งเข้า server เพื่อลดภาระ real-time sync
- Server รับเฉพาะ `png`, `jpg/jpeg`, `webp`, `gif` แบบ data URL และจำกัดขนาดรูปหลังย่อไม่เกิน 64KB
- Game Log และ Live Chat จะแสดง avatar พร้อมชื่อผู้เล่น เหมือนแชทกลุ่ม
- Log แต่ละรายการเก็บ snapshot สีและ avatar ของผู้เล่นไว้กับ event เพื่อให้ประวัติการเล่นยังแสดงหน้าคนทำ action ได้ครบ

## Deploy ออนไลน์

โค้ดชุดนี้พร้อมรันบนบริการที่รองรับ Python HTTP server + WebSocket แล้ว เพราะ `server.py` อ่านค่า `PORT` จาก environment และ bind เป็น `0.0.0.0` อัตโนมัติเมื่ออยู่บน hosting

### ล็อกการสร้างห้องให้เจ้าของเว็บเท่านั้น

เพื่อไม่ให้คนอื่นเข้าหน้าเว็บแล้วสร้างห้องเล่นเอง ให้ตั้ง Environment Variable บน Render:

```text
GOT_FIVE_OWNER_KEY=ตั้งรหัสลับของคุณเอง
```

หลังตั้งค่าแล้ว เฉพาะคนที่รู้รหัสนี้เท่านั้นถึงจะกดสร้างห้องได้ เพื่อนที่ได้รับเชิญยังเข้าห้องจาก invite link หรือรหัสห้องได้ตามปกติ และถ้าเกมเริ่มแล้วผู้เล่นใหม่จะเข้าไม่ได้

บน Render ให้ไปที่ `Environment` > `Add Environment Variable` แล้วเพิ่ม `GOT_FIVE_OWNER_KEY` จากนั้นกด deploy ใหม่

### Replit

1. สร้าง Python Repl ใหม่หรือ import โฟลเดอร์นี้เข้า Replit
2. ให้ไฟล์หลักเป็น `server.py`
3. กด Run หรือ Deploy
4. เมื่อได้ URL สาธารณะแล้ว ส่ง invite link จากใน Lobby ให้เพื่อนเข้าเล่นได้

### Render/Railway/Fly.io/VPS

ใช้ web command:

```text
python server.py
```

หรือใช้ `Procfile` ที่เตรียมไว้:

```text
web: python server.py
```

บน production ควรเปิดผ่าน HTTPS/WSS เพื่อให้มือถือและ browser สมัยใหม่เชื่อมต่อ WebSocket ได้เสถียร
