# GOT FIVE! คู่มือทำให้เล่นออนไลน์ถาวร

คู่มือนี้เขียนสำหรับคนที่ไม่ถนัด IT เป้าหมายคือเอาเกมนี้ขึ้นเป็นเว็บจริง แล้วส่งลิงก์ให้เพื่อนเล่นจากคนละบ้านได้

## สรุปก่อนเลือก

แนะนำให้เลือก 1 ทางจากนี้:

1. **Replit** - ง่ายสุดสำหรับมือใหม่ กดอัปโหลดไฟล์แล้ว Publish ได้จากหน้าเว็บ
2. **Render + GitHub** - เหมาะกับออนไลน์ถาวรกว่า อัปเดตเกมด้วยการอัปไฟล์เข้า GitHub แล้ว Render deploy ให้
3. **Cloudflare Tunnel** - ใช้เครื่องคุณเป็น server ที่บ้าน เหมาะถ้าจะเปิดเองและยอมให้คอมต้องเปิดตลอด

ถ้าไม่อยากยุ่งยาก ให้เริ่มจาก **Replit** ก่อน

## ไฟล์ที่ต้องใช้

ใช้ไฟล์ zip ล่าสุด:

`got-five-realtime-online.zip`

แตกไฟล์ออกมา จะได้โฟลเดอร์ `got-five-realtime` ที่มีไฟล์สำคัญเหล่านี้:

- `server.py`
- `public/`
- `requirements.txt`
- `Procfile`
- `.replit`
- `render.yaml`

## ทางเลือก A: Replit แบบมือใหม่ที่สุด

เหมาะกับ: อยากได้ลิงก์ออนไลน์เร็ว ไม่อยากแตะ GitHub ก่อน

1. เข้าเว็บ Replit แล้วสมัคร/ล็อกอิน
2. สร้าง App ใหม่ เลือก Python
3. ตั้งชื่อเช่น `got-five-realtime`
4. อัปโหลดไฟล์ทั้งหมดจากโฟลเดอร์ `got-five-realtime` เข้าไปใน Replit
5. ตรวจว่าใน Replit มีไฟล์ `.replit`
6. กด Run
7. ถ้า preview เปิดได้ ให้กด Publish/Deploy
8. Replit จะให้ public URL เอา URL นั้นส่งให้เพื่อน
9. เจ้าของเว็บเปิด URL แบบ `/owner` แล้วสร้างห้อง จากนั้นกด Copy Invite ส่ง invite link ให้เพื่อน

ค่าที่ต้องตั้ง:

- Run command: `python server.py`
- Port: ไม่ต้องตั้งเอง โค้ดอ่านจากระบบให้อัตโนมัติ

ข้อควรรู้:

- ถ้า Replit ให้เลือก deployment type ให้เลือกแบบ web app / autoscale หรือแบบที่ Replit แนะนำ
- ถ้ามีให้เพิ่ม payment method ให้ทำตามหน้า Replit เพราะนโยบายราคาเปลี่ยนได้
- ถ้า publish แล้วแก้ไฟล์ใหม่ ต้อง Publish/Deploy อีกรอบ

## ทางเลือก B: Render + GitHub สำหรับออนไลน์ถาวรกว่า

เหมาะกับ: อยากให้เป็นเว็บจริงนิ่งกว่า และอัปเดตในอนาคตง่าย

ภาพรวมแบบไม่ใช้ศัพท์ยาก:

1. GitHub คือที่เก็บโค้ด
2. Render คือเครื่อง server บนอินเทอร์เน็ต
3. เวลาเราอัปเดตโค้ดใน GitHub, Render จะเอาไปเปิดเป็นเว็บให้

### ขั้นที่ 1: เอาโค้ดขึ้น GitHub

1. สมัคร/ล็อกอิน GitHub
2. กด New repository
3. ตั้งชื่อเช่น `got-five-realtime`
4. เลือก Public หรือ Private ก็ได้
5. เข้า repo ที่สร้าง
6. กด Add file > Upload files
7. ลากไฟล์ทั้งหมดในโฟลเดอร์ `got-five-realtime` เข้าไป
8. กด Commit changes

ต้องเห็นไฟล์เหล่านี้ใน GitHub:

- `server.py`
- `render.yaml`
- `requirements.txt`
- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `public/assets/got-five-product.jpg`

### ขั้นที่ 2: สร้าง Web Service บน Render

1. เข้า Render แล้วสมัคร/ล็อกอิน
2. กด New > Web Service
3. เลือก Connect GitHub
4. เลือก repo `got-five-realtime`
5. ตั้งค่าตามนี้:

Name:

```text
got-five-realtime
```

Language:

```text
Python
```

Build Command:

```text
pip install -r requirements.txt
```

Start Command:

```text
python server.py
```

Health Check Path:

```text
/health
```

6. กด Create Web Service
7. รอจนสถานะขึ้น Live
8. Render จะให้ URL ประมาณ `https://got-five-realtime.onrender.com`
9. เจ้าของเว็บเปิด URL นั้นแบบเติม `/owner` เช่น `https://got-five-realtime.onrender.com/owner`
10. ใส่รหัสใช้งาน ตั้งรหัสห้อง แล้วกด Copy Invite ส่งให้เพื่อน

โค้ดนี้รองรับ Render แล้ว เพราะ `server.py` อ่านค่า `PORT` จากระบบ และ bind เป็น `0.0.0.0` เมื่ออยู่บน hosting

## ทางเลือก C: Cloudflare Tunnel เปิดจากคอมคุณเอง

เหมาะกับ: อยากใช้เครื่องตัวเองเป็น server ไม่อยากอัปขึ้น hosting ตอนนี้

ข้อสำคัญ:

- คอมคุณต้องเปิดตลอดเวลาที่เพื่อนเล่น
- ถ้าปิดคอม เกมหลุด
- แบบ Quick Tunnel ลิงก์จะเปลี่ยนทุกครั้ง
- ถ้าอยากได้ลิงก์ถาวร ต้องมีโดเมนและสร้าง Named Tunnel ใน Cloudflare

### แบบเร็วไว้ลองกับเพื่อน

1. เปิด PowerShell ในโฟลเดอร์เกม
2. รัน:

```powershell
python server.py
```

3. เปิด PowerShell อีกหน้าต่าง
4. รัน:

```powershell
cloudflared tunnel --url http://127.0.0.1:8787
```

5. Cloudflare จะให้ URL แบบ `https://xxxxx.trycloudflare.com`
6. เจ้าของเว็บเปิด URL นั้นแบบเติม `/owner` แล้วสร้างห้อง
7. ส่ง invite link ให้เพื่อน

### แบบถาวรด้วยโดเมนตัวเอง

1. สมัคร Cloudflare
2. เพิ่มโดเมนของคุณเข้า Cloudflare
3. เข้า Cloudflare Dashboard > Zero Trust > Networks > Tunnels
4. กด Create Tunnel
5. เลือก Windows และติดตั้ง `cloudflared`
6. ตั้ง Public Hostname เช่น `gotfive.yourdomain.com`
7. ตั้ง Service URL เป็น:

```text
http://localhost:8787
```

8. ให้ tunnel run เป็น service
9. เปิดเกมด้วย `https://gotfive.yourdomain.com`

## วิธีส่งให้เพื่อนเล่น

1. เจ้าของเว็บเปิด public URL ของเกมแบบเติม `/owner`
2. ใส่ชื่อ เลือกสี ใส่รูปโปรไฟล์
3. ใส่รหัสใช้งาน แล้วตั้งรหัสห้องเองได้ เช่น `ไส้ตัน` หรือ `enjoy`
4. กดสร้างห้อง
5. กด Copy Invite
6. ส่งลิงก์ให้เพื่อนทาง LINE/Discord/Facebook
7. เพื่อนเปิดจากมือถือหรือ PC ได้เลย

## ถ้าให้ผมช่วยทำต่อ

ผมเตรียมโค้ดและ config ให้พร้อมแล้ว แต่การ publish จริงต้องมีบัญชีของคุณ เพราะเป็นเว็บที่จะอยู่ใน account คุณ

ทางที่ผมช่วยต่อได้ง่ายที่สุด:

1. คุณสร้าง Replit หรือ Render account
2. คุณสร้างโปรเจกต์เปล่าหรือ repo เปล่า
3. ส่งชื่อโปรเจกต์/ลิงก์ repo มาในแชทนี้
4. ผมช่วยเช็กไฟล์ ตั้งค่า run command และตรวจว่า WebSocket เปิดได้

## ปัญหาที่เจอบ่อย

### Render ขึ้น `Could not open requirements file`

ถ้าใน Render logs เห็นข้อความนี้:

```text
ERROR: Could not open requirements file: [Errno 2] No such file or directory: 'requirements.txt'
```

แปลว่า Render มองหาไฟล์ `requirements.txt` ที่หน้าแรกสุดของ repo แต่ไม่เจอ

วิธีแก้แบบเร็ว:

1. เข้า GitHub repo ของเกม
2. กด Add file > Create new file
3. ตั้งชื่อไฟล์ว่า:

```text
requirements.txt
```

4. ใส่ข้อความนี้ลงไป:

```text
# This project currently uses only the Python standard library.
```

5. กด Commit changes
6. กลับไป Render แล้วกด Manual Deploy > Deploy latest commit

ถ้ายัง fail ต่อ ให้เช็กว่าไฟล์เหล่านี้ต้องอยู่หน้าแรกสุดของ repo ไม่ได้อยู่ในโฟลเดอร์ซ้อนอีกชั้น:

- `server.py`
- `requirements.txt`
- `render.yaml`
- `public/`

ตัวอย่างที่ถูก:

```text
Got-Five/
  server.py
  requirements.txt
  render.yaml
  public/
```

ตัวอย่างที่ผิด:

```text
Got-Five/
  got-five-realtime/
    server.py
    requirements.txt
```

ถ้าเป็นแบบผิด ให้เลือกอย่างใดอย่างหนึ่ง:

- ย้ายไฟล์ข้างใน `got-five-realtime/` ออกมาไว้หน้าแรกสุดของ repo
- หรือไปที่ Render > Settings > Root Directory แล้วใส่ `got-five-realtime`

หลังแก้แล้วกด Manual Deploy ใหม่

ถ้าเปิดเว็บแล้วเข้าไม่ได้:

- เช็กว่า server ขึ้นอยู่ไหม
- เช็กว่า URL เป็น `https://` ไม่ใช่ `http://` เมื่อต้องเล่นข้ามอินเทอร์เน็ต
- เช็กว่า hosting รองรับ WebSocket
- เปิด `/health` เช่น `https://your-url/health` ต้องเห็นข้อความว่า `ok`

ถ้าเพื่อนเข้าได้แต่เล่นไม่ sync:

- ให้ทุกคนใช้ invite link จากห้องเดียวกัน
- อย่าเปิดหลายแท็บด้วยชื่อเดียวกันตอนทดสอบ
- ถ้าเพิ่ง deploy ใหม่ ให้ทุกคน refresh

ถ้าเพื่อนกดลิงก์แล้วขึ้นว่า `ไม่พบห้องนี้` แต่เครื่องเจ้าของห้องยังเห็นห้องอยู่:

- ห้องนั้นเป็นห้องเก่าที่ค้างอยู่ในหน้า browser ของเจ้าของห้อง
- Render เพิ่ง restart/deploy ทำให้ room state ใน memory หายไปแล้ว
- ให้เจ้าของห้อง refresh หน้าเว็บก่อน
- ถ้าหน้าเว็บเด้งกลับไปหน้าเริ่มเกม ให้สร้างห้องใหม่ แล้ว copy invite link ใหม่ส่งให้เพื่อน
- ลิงก์ห้องเก่าก่อน restart/deploy ใช้ต่อไม่ได้

### Render เปิดเว็บได้ แต่กดสร้างห้อง/เริ่มเกมแล้วขึ้น JSON error

ถ้า Render logs มีข้อความประมาณนี้:

```text
json.decoder.JSONDecodeError: Unterminated string
json.decoder.JSONDecodeError: Expecting value
```

ให้ใช้ไฟล์ล่าสุดที่รวม fix WebSocket ไว้ใน `server.py` แล้วตั้งค่า Render แบบนี้:

ถ้า Render ใช้ Root Directory เป็น `got-five-realtime`:

```text
python server.py
```

ถ้า Render ไม่ได้ตั้ง Root Directory และไฟล์อยู่ในโฟลเดอร์ `got-five-realtime/`:

```text
python got-five-realtime/server.py
```

สาเหตุคือ hosting/proxy อาจแยก WebSocket message ที่มีรูปโปรไฟล์ base64 ออกเป็นหลาย frame ทำให้ `server.py` เวอร์ชันเก่าอ่าน JSON ได้ไม่ครบ ตอนนี้ fix ถูกใส่ไว้ใน `server.py` แล้ว ให้รันไฟล์นี้เป็นไฟล์หลัก

ถ้าห้องหาย:

- ตอนนี้ room state อยู่ใน memory ของ server
- ถ้า server restart ห้องจะหาย
- ถ้าจะเปิดจริงระยะยาว ค่อยเพิ่ม database สำหรับเก็บห้อง/ประวัติ

## แหล่งอ้างอิงทางการ

- Replit Publishing: https://docs.replit.com/learn/projects-and-artifacts/replit-deployments
- Render Web Services: https://render.com/docs/web-services
- Render WebSockets: https://render.com/docs/websocket
- Cloudflare Tunnel: https://developers.cloudflare.com/tunnel/
- Cloudflare Quick Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/

## Private Owner-Only Room Creation

ถ้าต้องการให้เว็บนี้เล่นได้เฉพาะห้องที่คุณสร้างและเชิญเท่านั้น ให้ตั้งค่า Environment Variable บน Render:

```text
GOT_FIVE_OWNER_KEY=ตั้งรหัสลับของคุณเอง
```

วิธีตั้งใน Render:

1. เข้า service `Got-Five`
2. ไปที่เมนู `Environment`
3. กด `Add Environment Variable`
4. ใส่ Key เป็น `GOT_FIVE_OWNER_KEY`
5. ใส่ Value เป็นรหัสลับที่คุณจำได้
6. กด Save แล้ว deploy ใหม่

หลังจากนี้หน้าเว็บปกติยังเปิดได้ แต่คนทั่วไปจะเห็นหน้าเข้าห้อง ไม่เห็นเครื่องมือสร้างห้อง ถ้าคุณจะสร้างห้องเองให้เปิด URL แบบนี้:

```text
https://got-five-6v45.onrender.com/owner
```

จากนั้นใส่รหัสใช้งานที่ตั้งไว้ใน `GOT_FIVE_OWNER_KEY` และตั้งรหัสห้องเองได้ เช่น `ไส้ตัน` หรือ `enjoy` เพื่อนต้องเข้าจาก invite link หรือรหัสห้องที่คุณสร้างไว้เท่านั้น
