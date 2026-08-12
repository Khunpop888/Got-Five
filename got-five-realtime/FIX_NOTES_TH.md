# GOT FIVE! - Performance & Private Board Fix

อัปเดตวันที่ 13 สิงหาคม 2026

## สิ่งที่แก้ไข

- Private Board ตอบสนองทันทีเมื่อกดตัดหรือคืนเลข โดยไม่สร้างหน้าเกมใหม่ทั้งหมด
- Server ตอบกลับการตัดเลขด้วย message ขนาดเล็กเฉพาะสถานะที่เปลี่ยน
- Heartbeat ใช้ `ping`/`pong` ขนาดเล็ก แทนการส่ง state ทั้งห้องทุก 25 วินาที
- ข้ามการ render เมื่อได้รับ state sync ที่ revision ไม่เปลี่ยน
- เปลี่ยนสถานะเลขที่ตัดให้เป็นพื้นมืดพร้อมเครื่องหมาย X สีแดงที่เห็นชัด
- ลด shadow, filter, backdrop และ animation ที่สร้างภาระบนหน้าจอขนาดเล็ก
- เลขทดบนไทล์ลับแยกตามเวลาเริ่มแมตช์ จึงยังอยู่ระหว่างแมตช์เดิม แต่เริ่มว่างเมื่อขึ้นแมตช์ใหม่
- เพิ่ม cache-busting version สำหรับ `app.js` และ `styles.css`

## การตรวจสอบ

- Python unit tests: 21 tests ผ่านทั้งหมด
- JavaScript syntax check: ผ่าน
- Browser test: ทดสอบตัด/คืนเลข, ตัวนับ Private Board, การคงเลขทดในแมตช์เดิม และการล้างเมื่อเริ่มแมตช์ถัดไป
- Responsive test: ทดสอบที่ viewport 390 x 844 โดยไม่มี horizontal page overflow
