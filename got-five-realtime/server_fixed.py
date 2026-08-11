from __future__ import annotations

import json
import struct
import traceback

import server

MAX_WS_MESSAGE_BYTES = 1024 * 1024


def handle_message(client: server.Client, message: str) -> None:
    message = message.strip()
    if not message:
        return
    try:
        try:
            packet = json.loads(message)
        except json.JSONDecodeError as exc:
            print(f"Ignoring invalid WebSocket JSON: {exc}; sample={message[:120]!r}")
            server.send_error(client, "ข้อมูลจาก browser มาไม่ครบ ลองกดอีกครั้งหรือรีเฟรชหน้าเว็บ")
            return

        event = packet.get("event")
        data = packet.get("data") or {}
        if not isinstance(data, dict):
            data = {}

        with server.ROOMS_LOCK:
            if event == "createRoom":
                server.handle_create_room(client, data)
            elif event == "joinRoom":
                server.handle_join_room(client, data)
            elif event == "updateProfile":
                server.handle_update_profile(client, data)
            elif event == "addBot":
                server.handle_add_bot(client)
            elif event == "removeBot":
                server.handle_remove_bot(client, data)
            elif event == "startGame":
                server.handle_start_game(client)
            elif event == "restart":
                server.handle_restart(client)
            elif event == "action":
                server.handle_action(client, data)
            elif event == "mark":
                server.handle_mark(client, data)
            elif event == "chat":
                server.handle_chat(client, data)
            elif event == "gotFive":
                server.handle_guess(client, data)
            elif event == "sync":
                room = server.require_room(client)
                client.send("state", server.serialize_room(room, client.player_id))
            else:
                raise server.GameError("ไม่รู้จัก event นี้")
    except server.GameError as exc:
        server.send_error(client, str(exc))
    except Exception as exc:
        traceback.print_exc()
        server.send_error(client, f"เกิดข้อผิดพลาด: {exc}")


def read_ws_frame(self: server.GotFiveHandler) -> tuple[bool, int, bytes] | None:
    header = self.read_exactly(2)
    if not header:
        return None
    first, second = header
    fin = bool(first & 0x80)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F

    if length == 126:
        data = self.read_exactly(2)
        if not data:
            return None
        length = struct.unpack("!H", data)[0]
    elif length == 127:
        data = self.read_exactly(8)
        if not data:
            return None
        length = struct.unpack("!Q", data)[0]

    if length > MAX_WS_MESSAGE_BYTES:
        return None

    mask = self.read_exactly(4) if masked else b""
    if masked and mask is None:
        return None

    payload = self.read_exactly(length)
    if payload is None:
        return None
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return fin, opcode, payload


def read_ws_text(self: server.GotFiveHandler) -> str | None:
    active_opcode: int | None = None
    fragments = bytearray()

    while True:
        frame = self.read_ws_frame()
        if frame is None:
            return None
        fin, opcode, payload = frame

        if opcode == 0x8:
            return None
        if opcode == 0x9:
            self.send_ws_frame(payload, opcode=0xA)
            continue
        if opcode == 0xA:
            continue

        if opcode == 0x1:
            active_opcode = opcode
            fragments = bytearray(payload)
        elif opcode == 0x2:
            active_opcode = opcode if not fin else None
            fragments = bytearray()
            continue
        elif opcode == 0x0:
            if active_opcode is None:
                continue
            if active_opcode == 0x1:
                fragments.extend(payload)
            if active_opcode == 0x2:
                if fin:
                    active_opcode = None
                continue
        else:
            continue

        if len(fragments) > MAX_WS_MESSAGE_BYTES:
            return None
        if fin and active_opcode == 0x1:
            return fragments.decode("utf-8", errors="replace")
        if fin:
            active_opcode = None


server.GotFiveHandler.read_ws_frame = read_ws_frame
server.GotFiveHandler.read_ws_text = read_ws_text
server.handle_message = handle_message

if __name__ == "__main__":
    server.run()
