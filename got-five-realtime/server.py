from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import random
import secrets
import socket
import struct
import threading
import time
import traceback
import unicodedata
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT_DIR / "public"
HOST = os.environ.get("GOT_FIVE_HOST") or ("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
PORT = int(os.environ.get("GOT_FIVE_PORT") or os.environ.get("PORT") or "8787")
OWNER_KEY = os.environ.get("GOT_FIVE_OWNER_KEY", "").strip()
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_AVATAR_BYTES = 256 * 1024
MAX_WS_MESSAGE_BYTES = 1024 * 1024
MAX_ROOM_CODE_LEN = 24

ROOMS: dict[str, "Room"] = {}
ROOMS_LOCK = threading.RLock()

PLAYER_COLORS = [
    {"key": "cyan", "name": "Cyan", "hex": "#00a7c7"},
    {"key": "blue", "name": "Blue", "hex": "#2563eb"},
    {"key": "teal", "name": "Teal", "hex": "#0d9488"},
    {"key": "violet", "name": "Violet", "hex": "#7c3aed"},
    {"key": "indigo", "name": "Indigo", "hex": "#4f46e5"},
    {"key": "rose", "name": "Rose", "hex": "#e11d48"},
    {"key": "pink", "name": "Pink", "hex": "#db2777"},
    {"key": "red", "name": "Red", "hex": "#dc2626"},
    {"key": "amber", "name": "Amber", "hex": "#f59e0b"},
    {"key": "orange", "name": "Orange", "hex": "#ea580c"},
    {"key": "emerald", "name": "Emerald", "hex": "#059669"},
    {"key": "lime", "name": "Lime", "hex": "#65a30d"},
    {"key": "slate", "name": "Slate", "hex": "#475569"},
    {"key": "zinc", "name": "Zinc", "hex": "#3f3f46"},
]


@dataclass
class Tile:
    id: int
    num: int
    color_index: int
    dots: int


@dataclass
class Player:
    id: str
    session_token: str
    name: str
    color: str
    seat: int
    avatar: str = ""
    kind: str = "human"
    connected: bool = True
    active: bool = True
    eliminated: bool = False
    disconnected_at: float | None = None
    tiles: list[Tile] = field(default_factory=list)
    notches: list[list[Tile]] = field(default_factory=lambda: [[] for _ in range(6)])
    compares: list[list[dict[str, Any]]] = field(default_factory=lambda: [[] for _ in range(5)])
    marks: set[int] = field(default_factory=set)
    stats: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.stats:
            self.stats = default_stats()


@dataclass
class Room:
    code: str
    max_players: int
    host_id: str
    status: str = "lobby"
    phase: str = "lobby"
    players: list[Player] = field(default_factory=list)
    decks: list[list[Tile]] = field(default_factory=lambda: [[] for _ in range(5)])
    center: list[Tile] = field(default_factory=list)
    turn_index: int = 0
    turn_count: int = 0
    turn_started_at: float | None = None
    starter_id: str | None = None
    revision: int = 0
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    ended_at: float | None = None
    log: list[dict[str, Any]] = field(default_factory=list)
    chat: list[dict[str, Any]] = field(default_factory=list)
    rankings: list[dict[str, Any]] = field(default_factory=list)
    match_total: int = 1
    match_index: int = 1
    match_history: list[dict[str, Any]] = field(default_factory=list)
    series_scores: dict[str, dict[str, Any]] = field(default_factory=dict)
    clients: set["Client"] = field(default_factory=set)
    bot_timers: list[threading.Timer] = field(default_factory=list)


class GameError(Exception):
    pass


class Client:
    def __init__(self, handler: "GotFiveHandler") -> None:
        self.handler = handler
        self.id = secrets.token_urlsafe(9)
        self.room_code: str | None = None
        self.player_id: str | None = None
        self.alive = True
        self.send_lock = threading.Lock()

    def send(self, event: str, data: Any) -> None:
        if not self.alive:
            return
        payload = json.dumps({"event": event, "data": data}, ensure_ascii=False)
        raw = payload.encode("utf-8")
        try:
            with self.send_lock:
                self.handler.send_ws_text(raw)
        except (BrokenPipeError, ConnectionError, OSError):
            self.alive = False


def now_ms() -> int:
    return int(time.time() * 1000)


def default_stats() -> dict[str, Any]:
    return {
        "turns": 0,
        "draws": 0,
        "categorises": 0,
        "compares": 0,
        "compareYes": 0,
        "compareNo": 0,
        "cluesGiven": 0,
        "gotFiveAttempts": 0,
        "bestExactMatches": 0,
        "exactMatchesTotal": 0,
        "lastGuess": [],
        "lastAccuracyPct": None,
        "boardMarks": 0,
        "turnTimeTotalSec": 0,
        "slowestTurnSec": 0,
        "lastTurnSec": 0,
        "eliminatedAtTurn": None,
        "wonAtTurn": None,
    }


def sanitize_name(value: Any) -> str:
    if not isinstance(value, str):
        return "Player"
    cleaned = " ".join(value.replace("\x00", "").strip().split())
    if not cleaned:
        return "Player"
    return cleaned[:24]


def sanitize_chat(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = value.replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()
    return cleaned[:240]


def sanitize_avatar(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = value.strip()
    if not cleaned or "," not in cleaned:
        return ""
    header, encoded = cleaned.split(",", 1)
    allowed = {
        "data:image/png;base64": "image/png",
        "data:image/jpeg;base64": "image/jpeg",
        "data:image/jpg;base64": "image/jpeg",
        "data:image/webp;base64": "image/webp",
        "data:image/gif;base64": "image/gif",
    }
    mime = allowed.get(header.lower())
    if not mime or len(encoded) > MAX_AVATAR_BYTES * 2:
        return ""
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception:
        return ""
    if not raw or len(raw) > MAX_AVATAR_BYTES:
        return ""
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def valid_color(value: Any) -> str:
    keys = {item["key"] for item in PLAYER_COLORS}
    return value if isinstance(value, str) and value in keys else PLAYER_COLORS[0]["key"]


def safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def sanitize_match_total(value: Any) -> int:
    return min(5, max(1, safe_int(value, 1)))


def sanitize_room_code(value: Any, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        if allow_empty:
            return ""
        raise GameError("กรอกรหัสห้องก่อน")
    cleaned = value.replace("\x00", "").strip()
    if not cleaned:
        if allow_empty:
            return ""
        raise GameError("กรอกรหัสห้องก่อน")
    if len(cleaned) > MAX_ROOM_CODE_LEN:
        raise GameError(f"รหัสห้องยาวเกินไป ใช้ได้ไม่เกิน {MAX_ROOM_CODE_LEN} ตัวอักษร")
    for char in cleaned:
        category = unicodedata.category(char)
        allowed = category[0] in {"L", "N", "M"} or char in {"-", "_"}
        if not allowed:
            raise GameError("รหัสห้องใช้ได้เฉพาะตัวอักษร ตัวเลข ภาษาไทย ขีดกลาง หรือขีดล่าง")
    return cleaned


def room_lookup_key(code: str) -> str:
    return unicodedata.normalize("NFKC", code).casefold()


def require_owner_key(data: dict[str, Any]) -> None:
    if not OWNER_KEY:
        if not os.environ.get("PORT"):
            return
        raise GameError("ยังไม่ได้ตั้งรหัสเจ้าของเว็บใน Render: GOT_FIVE_OWNER_KEY")
    provided = str(data.get("ownerKey") or "").strip()
    if not provided or not secrets.compare_digest(provided, OWNER_KEY):
        raise GameError("สร้างห้องได้เฉพาะเจ้าของเว็บเท่านั้น กรุณาใส่รหัสเจ้าของให้ถูกต้อง")


def make_room_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(5))
        if room_lookup_key(code) not in ROOMS:
            return code


def tile_public(tile: Tile) -> dict[str, int]:
    return {
        "id": tile.id,
        "num": tile.num,
        "colorIndex": tile.color_index,
        "dots": tile.dots,
    }


def compare_public(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "tile": tile_public(entry["tile"]),
        "isSame": bool(entry["isSame"]),
        "askedBy": entry["askedBy"],
        "answeredBy": entry["answeredBy"],
        "atTurn": entry["atTurn"],
    }


def get_player(room: Room, player_id: str | None) -> Player | None:
    if not player_id:
        return None
    return next((player for player in room.players if player.id == player_id), None)


def active_players(room: Room) -> list[Player]:
    return [player for player in room.players if player.active]


def ranked_player_ids(room: Room) -> set[str]:
    return {entry["playerId"] for entry in room.rankings}


def ranking_for_player(room: Room, player_id: str) -> dict[str, Any] | None:
    return next((entry for entry in room.rankings if entry["playerId"] == player_id), None)


def ranking_entry(player: Player, rank: int, status: str) -> dict[str, Any]:
    return {
        "rank": rank,
        "playerId": player.id,
        "name": player.name,
        "color": player.color,
        "avatar": player.avatar,
        "status": status,
        "score": max(player.stats["bestExactMatches"], 0),
    }


def add_ranking(room: Room, player: Player, status: str) -> dict[str, Any]:
    existing = ranking_for_player(room, player.id)
    if existing:
        return existing
    final_status = status
    if status == "finished" and not room.rankings:
        final_status = "winner"
    entry = ranking_entry(player, len(room.rankings) + 1, final_status)
    room.rankings.append(entry)
    return entry


def current_player(room: Room) -> Player | None:
    if not room.players or room.status != "playing":
        return None
    room.turn_index %= len(room.players)
    return room.players[room.turn_index]


def is_color_taken(room: Room, color: str, except_player_id: str | None = None) -> bool:
    return any(player.color == color and player.id != except_player_id for player in room.players)


def first_available_color(room: Room, desired: str = "cyan", except_player_id: str | None = None) -> str:
    desired = valid_color(desired)
    if not is_color_taken(room, desired, except_player_id):
        return desired
    for item in PLAYER_COLORS:
        if not is_color_taken(room, item["key"], except_player_id):
            return item["key"]
    return desired


def create_player(name: str, color: str, seat: int, kind: str = "human", avatar: str = "") -> Player:
    return Player(
        id=secrets.token_urlsafe(8),
        session_token=secrets.token_urlsafe(24),
        name=sanitize_name(name),
        color=valid_color(color),
        seat=seat,
        avatar=sanitize_avatar(avatar),
        kind=kind,
        connected=kind == "human",
    )


def add_log(room: Room, event_type: str, actor_id: str | None, message: str, payload: dict[str, Any] | None = None) -> None:
    actor = get_player(room, actor_id)
    room.log.append(
        {
            "id": secrets.token_urlsafe(6),
            "time": now_ms(),
            "type": event_type,
            "actorId": actor_id,
            "actorName": actor.name if actor else "System",
            "actorColor": actor.color if actor else "slate",
            "actorAvatar": actor.avatar if actor else "",
            "message": message,
            "payload": payload or {},
        }
    )
    room.log = room.log[-120:]


def build_master_decks() -> list[list[Tile]]:
    decks: list[list[Tile]] = [[] for _ in range(5)]
    for num in range(1, 61):
        color_index = (num - 1) % 5
        column = (num - 1) // 5
        dots = (column % 3) + 1
        decks[color_index].append(Tile(id=num, num=num, color_index=color_index, dots=dots))
    for deck in decks:
        random.shuffle(deck)
    return decks


def reset_player_for_match(player: Player) -> None:
    player.active = True
    player.eliminated = False
    player.tiles = []
    player.notches = [[] for _ in range(6)]
    player.compares = [[] for _ in range(5)]
    player.marks.clear()
    player.stats = default_stats()


def start_room_game(room: Room, starter_index: int | None = None) -> None:
    if room.status not in {"lobby", "between_matches"}:
        raise GameError("เกมเริ่มไปแล้ว")
    if len(room.players) < 2:
        raise GameError("ต้องมีผู้เล่นอย่างน้อย 2 คน")
    if len(room.players) > room.max_players:
        raise GameError("จำนวนผู้เล่นเกินจำนวนสูงสุดของห้อง")
    if room.status == "lobby":
        room.match_index = 1
        room.match_history = []
        room.series_scores = {}
    else:
        if room.match_index >= room.match_total:
            raise GameError("เล่นครบจำนวนเกมแล้ว")
        room.match_index += 1

    room.decks = build_master_decks()
    room.center = []
    room.rankings = []
    room.log = []
    room.chat = room.chat[-60:]
    room.turn_count = 0
    room.turn_index = starter_index if starter_index is not None else secrets.randbelow(len(room.players))
    room.turn_index %= len(room.players)
    room.started_at = time.time()
    room.turn_started_at = room.started_at
    room.ended_at = None
    room.status = "playing"
    room.phase = "draw"
    room.revision += 1

    for player in room.players:
        reset_player_for_match(player)
        for color_index in range(5):
            player.tiles.append(room.decks[color_index].pop())
        player.tiles.sort(key=lambda item: item.num)

    for color_index in range(5):
        room.center.append(room.decks[color_index].pop())

    starter = current_player(room)
    room.starter_id = starter.id if starter else None
    add_log(
        room,
        "system",
        None,
        f"เริ่มเกมที่ {room.match_index}/{room.match_total} แจกไทล์ลับ เปิดไทล์กลางครบ 5 สี และสุ่มให้ {starter.name if starter else 'ผู้เล่น'} เริ่มก่อน",
        {"starterId": starter.id if starter else None},
    )


def restart_room_to_lobby(room: Room) -> None:
    cancel_bot_timers(room)
    room.status = "lobby"
    room.phase = "lobby"
    room.decks = [[] for _ in range(5)]
    room.center = []
    room.turn_index = 0
    room.turn_count = 0
    room.turn_started_at = None
    room.starter_id = None
    room.started_at = None
    room.ended_at = None
    room.rankings = []
    room.match_index = 1
    room.match_history = []
    room.series_scores = {}
    room.log = []
    for player in room.players:
        reset_player_for_match(player)
    room.revision += 1
    add_log(room, "system", None, "กลับสู่ Lobby พร้อมเริ่มแมตช์ใหม่")


def ensure_playing_turn(room: Room, player: Player, expected_phase: str) -> None:
    if room.status != "playing":
        raise GameError("เกมยังไม่อยู่ในสถานะเล่น")
    if not player.active:
        raise GameError("คุณอยู่ในโหมดผู้ชมแล้ว")
    current = current_player(room)
    if not current or current.id != player.id:
        raise GameError("ยังไม่ใช่ตาของคุณ")
    if room.phase != expected_phase:
        raise GameError("ยังไม่ถึงขั้นตอนนี้")


def find_center_tile(room: Room, tile_id: Any) -> Tile:
    try:
        requested = int(tile_id)
    except (TypeError, ValueError):
        raise GameError("เลือกไทล์กลางไม่ถูกต้อง") from None
    for tile in room.center:
        if tile.id == requested:
            return tile
    raise GameError("ไทล์กลางใบนี้ไม่มีอยู่แล้ว")


def remove_center_tile(room: Room, tile: Tile) -> None:
    room.center = [item for item in room.center if item.id != tile.id]


def validate_responder(room: Room, actor: Player, responder_id: Any) -> Player:
    responder = get_player(room, str(responder_id))
    if not responder:
        raise GameError("ไม่พบผู้เล่นที่จะตอบคำใบ้")
    if responder.id == actor.id:
        raise GameError("ต้องเลือกผู้เล่นคนอื่นเป็นคนตอบคำใบ้")
    if not responder.active:
        raise GameError("ผู้เล่นคนนี้ตกรอบไปแล้ว")
    return responder


def apply_draw(room: Room, player: Player, color_index: Any) -> dict[str, Any]:
    ensure_playing_turn(room, player, "draw")
    try:
        color = int(color_index)
    except (TypeError, ValueError):
        raise GameError("สีที่เลือกไม่ถูกต้อง") from None
    if color < 0 or color > 4:
        raise GameError("สีที่เลือกไม่ถูกต้อง")
    if not room.decks[color]:
        raise GameError("กองสีนี้หมดแล้ว")

    tile = room.decks[color].pop()
    room.center.append(tile)
    player.stats["draws"] += 1
    room.phase = "action"
    room.revision += 1
    add_log(room, "draw", player.id, f"{player.name} จั่วไทล์ {tile.num}", {"tile": tile_public(tile)})
    return {"tile": tile_public(tile)}


def apply_categorise(room: Room, player: Player, responder_id: Any, center_tile_id: Any) -> dict[str, Any]:
    ensure_playing_turn(room, player, "action")
    responder = validate_responder(room, player, responder_id)
    tile = find_center_tile(room, center_tile_id)

    notch_index = 0
    for secret_tile in player.tiles:
        if tile.num > secret_tile.num:
            notch_index += 1
    player.notches[notch_index].append(tile)
    player.notches[notch_index].sort(key=lambda item: item.num)
    remove_center_tile(room, tile)

    player.stats["categorises"] += 1
    responder.stats["cluesGiven"] += 1
    room.revision += 1
    add_log(
        room,
        "categorise",
        player.id,
        f"{player.name} ให้ {responder.name} จัดไทล์ {tile.num} ลงช่องบนแท่นของตัวเอง",
        {"tile": tile_public(tile), "responderId": responder.id, "notchIndex": notch_index},
    )
    end_turn(room)
    return {"tile": tile_public(tile), "responderId": responder.id, "notchIndex": notch_index}


def apply_compare(room: Room, player: Player, responder_id: Any, center_tile_id: Any, slot_index: Any) -> dict[str, Any]:
    ensure_playing_turn(room, player, "action")
    responder = validate_responder(room, player, responder_id)
    tile = find_center_tile(room, center_tile_id)
    try:
        slot = int(slot_index)
    except (TypeError, ValueError):
        raise GameError("ตำแหน่งไทล์ไม่ถูกต้อง") from None
    if slot < 0 or slot >= len(player.tiles):
        raise GameError("ตำแหน่งไทล์ไม่ถูกต้อง")

    is_same = tile.dots == player.tiles[slot].dots
    entry = {
        "tile": tile,
        "isSame": is_same,
        "askedBy": player.id,
        "answeredBy": responder.id,
        "atTurn": room.turn_count + 1,
    }
    player.compares[slot].append(entry)
    remove_center_tile(room, tile)

    player.stats["compares"] += 1
    player.stats["compareYes" if is_same else "compareNo"] += 1
    responder.stats["cluesGiven"] += 1
    room.revision += 1
    add_log(
        room,
        "compare",
        player.id,
        f"{player.name} ให้ {responder.name} เทียบจุดไทล์ {tile.num}: {'ใช่' if is_same else 'ไม่ใช่'}",
        {"tile": tile_public(tile), "responderId": responder.id, "slotIndex": slot, "isSame": is_same},
    )
    end_turn(room)
    return {"tile": tile_public(tile), "responderId": responder.id, "slotIndex": slot, "isSame": is_same}


def apply_mark(player: Player, number: Any, marked: Any) -> None:
    try:
        num = int(number)
    except (TypeError, ValueError):
        raise GameError("เลขบนกระดานไม่ถูกต้อง") from None
    if num < 1 or num > 60:
        raise GameError("เลขบนกระดานไม่ถูกต้อง")
    if bool(marked):
        player.marks.add(num)
    else:
        player.marks.discard(num)
    player.stats["boardMarks"] = len(player.marks)


def final_rankings(room: Room) -> list[dict[str, Any]]:
    ordered: list[tuple[Player, str]] = []
    seen: set[str] = set()

    for entry in room.rankings:
        player = get_player(room, entry.get("playerId"))
        if player and player.id not in seen:
            ordered.append((player, entry.get("status", "finished")))
            seen.add(player.id)

    unfinished = [player for player in room.players if player.id not in seen and not player.eliminated]
    unfinished.sort(key=score_for_ranking, reverse=True)
    for player in unfinished:
        ordered.append((player, "unfinished"))
        seen.add(player.id)

    eliminated = [player for player in room.players if player.id not in seen and player.eliminated]
    eliminated.sort(key=lambda item: (item.stats["eliminatedAtTurn"] or -1, score_for_ranking(item)), reverse=True)
    for player in eliminated:
        ordered.append((player, "eliminated"))
        seen.add(player.id)

    return [ranking_entry(player, index + 1, status) for index, (player, status) in enumerate(ordered)]


def maybe_finish_room(room: Room, reason: str = "complete") -> bool:
    if room.status != "playing":
        return True

    ranked = ranked_player_ids(room)
    unranked = [player for player in room.players if player.id not in ranked]
    active_unranked = [player for player in unranked if player.active]

    if len(active_unranked) == 1 and all(player.id == active_unranked[0].id or player.eliminated for player in unranked):
        survivor = active_unranked[0]
        survivor.active = False
        survivor.stats["wonAtTurn"] = survivor.stats["wonAtTurn"] or room.turn_count + 1
        entry = add_ranking(room, survivor, "survivor")
        add_log(room, "gotfive", survivor.id, f"{survivor.name} อยู่รอดเป็นคนสุดท้าย ได้อันดับ #{entry['rank']}")

    if not any(player.active for player in room.players):
        finish_room(room, winner_id=None, reason=reason)
        return True
    return False


def apply_guess(room: Room, player: Player, guess: Any) -> dict[str, Any]:
    if room.status != "playing":
        raise GameError("เกมยังไม่อยู่ในสถานะเล่น")
    if not player.active:
        raise GameError("คุณอยู่ในโหมดผู้ชมแล้ว")
    if not isinstance(guess, list) or len(guess) != 5:
        raise GameError("ต้องทายตัวเลข 5 ช่อง")
    try:
        guess_nums = [int(item) for item in guess]
    except (TypeError, ValueError):
        raise GameError("คำตอบต้องเป็นตัวเลข") from None
    if any(num < 1 or num > 60 for num in guess_nums):
        raise GameError("ตัวเลขต้องอยู่ระหว่าง 1-60")

    actual = [tile.num for tile in player.tiles]
    exact_matches = sum(1 for expected, got in zip(actual, guess_nums) if expected == got)
    is_correct = guess_nums == actual
    player.stats["gotFiveAttempts"] += 1
    player.stats["bestExactMatches"] = max(player.stats["bestExactMatches"], exact_matches)
    player.stats["exactMatchesTotal"] += exact_matches
    player.stats["lastGuess"] = guess_nums
    player.stats["lastAccuracyPct"] = round(exact_matches / 5 * 100)

    if is_correct:
        player.active = False
        player.eliminated = False
        player.stats["wonAtTurn"] = room.turn_count + 1
        add_log(room, "gotfive", player.id, f"{player.name} ประกาศ GOT FIVE! ถูกต้องและชนะทันที")
        entry = add_ranking(room, player, "finished")
        room.log[-1]["message"] = f"{player.name} ประกาศ GOT FIVE! ถูกต้อง ได้อันดับ #{entry['rank']} แล้วออกจากรอบ"
        if current_player(room) and current_player(room).id == player.id:
            end_turn(room, count_turn=False)
        else:
            maybe_finish_room(room, reason="all_players_done")
    else:
        player.active = False
        player.eliminated = True
        player.stats["eliminatedAtTurn"] = room.turn_count + 1
        add_log(room, "gotfive", player.id, f"{player.name} ประกาศ GOT FIVE! ผิดและตกรอบ")
        room.log[-1]["message"] = f"{player.name} ประกาศ GOT FIVE! ผิด แพ้ทันทีและออกจากรอบ"
        if current_player(room) and current_player(room).id == player.id:
            end_turn(room, count_turn=False)
        if room.status == "playing":
            maybe_finish_room(room, reason="all_players_done")

    room.revision += 1
    return {
        "isCorrect": is_correct,
        "guess": guess_nums,
        "actual": actual,
        "exactMatches": exact_matches,
        "accuracyPct": round(exact_matches / 5 * 100),
    }


def record_turn_time(room: Room, player: Player) -> int:
    if not room.turn_started_at:
        return 0
    elapsed = max(0, int(time.time() - room.turn_started_at))
    player.stats["lastTurnSec"] = elapsed
    player.stats["turnTimeTotalSec"] = safe_int(player.stats.get("turnTimeTotalSec"), 0) + elapsed
    player.stats["slowestTurnSec"] = max(safe_int(player.stats.get("slowestTurnSec"), 0), elapsed)
    return elapsed


def end_turn(room: Room, count_turn: bool = True) -> None:
    if room.status != "playing":
        return
    current = current_player(room)
    if current and count_turn:
        record_turn_time(room, current)
        current.stats["turns"] += 1
        room.turn_count += 1

    if maybe_finish_room(room, reason="survival"):
        return

    for _ in range(len(room.players)):
        room.turn_index = (room.turn_index + 1) % len(room.players)
        candidate = room.players[room.turn_index]
        if candidate.active:
            room.phase = "draw"
            room.turn_started_at = time.time()
            room.revision += 1
            if not any(room.decks) and not room.center:
                finish_room(room, winner_id=None, reason="no_tiles")
            elif not any(room.decks):
                room.phase = "action"
            return


def score_for_ranking(player: Player) -> tuple[int, int, int, int]:
    clues = player.stats["categorises"] + player.stats["compares"]
    return (
        int(player.active),
        int(player.stats["bestExactMatches"]),
        int(clues),
        -int(player.stats["turns"]),
    )


def finish_room(room: Room, winner_id: str | None, reason: str) -> None:
    if room.status != "playing":
        return
    if winner_id:
        winner = get_player(room, winner_id)
        if winner:
            winner.active = False
            add_ranking(room, winner, "finished")
    saved_rankings = list(room.rankings)
    room.ended_at = time.time()
    cancel_bot_timers(room)

    ordered: list[Player] = []
    if winner_id:
        winner = get_player(room, winner_id)
        if winner:
            winner.active = False
            ordered.append(winner)

    remaining = [player for player in room.players if player.id not in {item.id for item in ordered}]
    remaining.sort(key=score_for_ranking, reverse=True)
    ordered.extend(remaining)
    room.rankings = [
        {
            "rank": index + 1,
            "playerId": player.id,
            "name": player.name,
            "color": player.color,
            "avatar": player.avatar,
            "status": "winner" if index == 0 and winner_id == player.id else ("eliminated" if player.eliminated else "unfinished"),
            "score": max(player.stats["bestExactMatches"], 0),
        }
        for index, player in enumerate(ordered)
    ]
    room.rankings = saved_rankings
    room.rankings = final_rankings(room)
    is_final_match = room.match_index >= room.match_total
    room.status = "finished" if is_final_match else "between_matches"
    room.phase = "finished" if is_final_match else "between"
    apply_match_to_series(room)
    if is_final_match:
        add_log(room, "system", None, f"จบซีรีส์ครบ {room.match_total} เกม ({reason})")
    else:
        add_log(room, "system", None, f"จบเกมที่ {room.match_index}/{room.match_total} ({reason}) รอเริ่มเกมถัดไป")
    room.match_history.append(summarize_match(room))
    room.match_history = room.match_history[-5:]
    room.revision += 1


def cancel_bot_timers(room: Room) -> None:
    for timer in room.bot_timers:
        timer.cancel()
    room.bot_timers = []


def serialize_player(room: Room, player: Player, viewer: Player | None) -> dict[str, Any]:
    reveal_phase = room.status in {"finished", "between_matches"}
    viewer_is_spectator = bool(viewer and (not viewer.active or reveal_phase))
    reveal_tiles = reveal_phase or viewer_is_spectator or not viewer or viewer.id != player.id
    ranking = ranking_for_player(room, player.id)
    tiles: list[dict[str, Any]] = []
    for index, tile in enumerate(player.tiles):
        if reveal_tiles:
            item: dict[str, Any] = tile_public(tile)
            item["slot"] = index
            item["hidden"] = False
        else:
            item = {"slot": index, "colorIndex": tile.color_index, "hidden": True}
        tiles.append(item)

    return {
        "id": player.id,
        "name": player.name,
        "color": player.color,
        "avatar": player.avatar,
        "seat": player.seat,
        "kind": player.kind,
        "connected": player.connected,
        "active": player.active,
        "eliminated": player.eliminated,
        "finished": bool(player.stats.get("wonAtTurn")) and not player.eliminated,
        "rank": ranking["rank"] if ranking else None,
        "rankStatus": ranking["status"] if ranking else None,
        "isHost": player.id == room.host_id,
        "tiles": tiles,
        "notches": [[tile_public(tile) for tile in notch] for notch in player.notches],
        "compares": [[compare_public(entry) for entry in stack] for stack in player.compares],
        "stats": public_stats(player),
    }


def public_stats(player: Player) -> dict[str, Any]:
    stats = dict(player.stats)
    attempts = stats["gotFiveAttempts"]
    stats["avgAccuracyPct"] = round(stats["exactMatchesTotal"] / (attempts * 5) * 100) if attempts else None
    turns = safe_int(stats.get("turns"), 0)
    stats["avgTurnSec"] = round(safe_int(stats.get("turnTimeTotalSec"), 0) / turns) if turns else None
    return stats


SERIES_STAT_FIELDS = [
    "turns",
    "draws",
    "categorises",
    "compares",
    "compareYes",
    "compareNo",
    "cluesGiven",
    "gotFiveAttempts",
    "bestExactMatches",
    "exactMatchesTotal",
    "boardMarks",
    "turnTimeTotalSec",
    "slowestTurnSec",
]


def empty_series_score(player: Player) -> dict[str, Any]:
    return {
        "playerId": player.id,
        "name": player.name,
        "color": player.color,
        "avatar": player.avatar,
        "games": 0,
        "wins": 0,
        "points": 0,
        "rankTotal": 0,
        "medals": {"gold": 0, "silver": 0, "bronze": 0, "fourth": 0},
        "statusCounts": {"winner": 0, "finished": 0, "survivor": 0, "unfinished": 0, "eliminated": 0},
        "stats": {field: 0 for field in SERIES_STAT_FIELDS},
    }


def ensure_series_score(room: Room, player: Player) -> dict[str, Any]:
    entry = room.series_scores.get(player.id)
    if not entry:
        entry = empty_series_score(player)
        room.series_scores[player.id] = entry
    entry["name"] = player.name
    entry["color"] = player.color
    entry["avatar"] = player.avatar
    return entry


def apply_match_to_series(room: Room) -> None:
    player_count = max(1, len(room.players))
    for rank in room.rankings:
        player = get_player(room, rank.get("playerId"))
        if not player:
            continue
        entry = ensure_series_score(room, player)
        rank_num = safe_int(rank.get("rank"), player_count)
        status = str(rank.get("status") or "unfinished")
        points = max(0, player_count - rank_num + 1)
        entry["games"] += 1
        entry["points"] += points
        entry["rankTotal"] += rank_num
        entry["statusCounts"][status] = entry["statusCounts"].get(status, 0) + 1
        if rank_num == 1:
            entry["wins"] += 1
            entry["medals"]["gold"] += 1
        elif rank_num == 2:
            entry["medals"]["silver"] += 1
        elif rank_num == 3:
            entry["medals"]["bronze"] += 1
        elif rank_num == 4:
            entry["medals"]["fourth"] += 1
        for field in SERIES_STAT_FIELDS:
            if field == "slowestTurnSec":
                entry["stats"][field] = max(entry["stats"].get(field, 0), safe_int(player.stats.get(field), 0))
            else:
                entry["stats"][field] = entry["stats"].get(field, 0) + safe_int(player.stats.get(field), 0)


def series_standings(room: Room) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for player in sorted(room.players, key=lambda item: item.seat):
        base = ensure_series_score(room, player)
        entry = {
            **base,
            "medals": dict(base["medals"]),
            "statusCounts": dict(base["statusCounts"]),
            "stats": dict(base["stats"]),
        }
        games = max(1, entry["games"])
        attempts = entry["stats"].get("gotFiveAttempts", 0)
        entry["avgRank"] = round(entry["rankTotal"] / games, 2) if entry["games"] else None
        entry["avgAccuracyPct"] = (
            round(entry["stats"].get("exactMatchesTotal", 0) / (attempts * 5) * 100)
            if attempts
            else None
        )
        entries.append(entry)

    def sort_key(entry: dict[str, Any]) -> tuple[int, int, int, float, int, int]:
        avg_rank = entry["avgRank"] if entry["avgRank"] is not None else 99
        return (
            -safe_int(entry.get("wins"), 0),
            -safe_int(entry.get("points"), 0),
            -safe_int(entry.get("stats", {}).get("bestExactMatches"), 0),
            avg_rank,
            safe_int(entry.get("stats", {}).get("turns"), 0),
            safe_int(next((player.seat for player in room.players if player.id == entry["playerId"]), 99), 99),
        )

    entries.sort(key=sort_key)
    for index, entry in enumerate(entries):
        entry["seriesRank"] = index + 1
    return entries


def match_action_counts(log: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"draw": 0, "categorise": 0, "compare": 0, "gotfive": 0, "system": 0}
    for item in log:
        item_type = str(item.get("type") or "system")
        counts[item_type] = counts.get(item_type, 0) + 1
    return counts


def round_info(room: Room) -> dict[str, int]:
    total = max(1, len(room.players))
    completed = room.turn_count // total
    return {
        "current": completed + 1,
        "completed": completed,
        "position": (room.turn_count % total) + 1,
        "total": total,
    }


def number_color_index(num: int) -> int:
    return (num - 1) % 5


def number_dots(num: int) -> int:
    return (((num - 1) // 5) % 3) + 1


def bot_visible_numbers(room: Room, player: Player) -> set[int]:
    numbers = {tile.num for tile in room.center}
    for other in room.players:
        if other.id != player.id:
            numbers.update(tile.num for tile in other.tiles)
        for notch in other.notches:
            numbers.update(tile.num for tile in notch)
        for stack in other.compares:
            numbers.update(entry["tile"].num for entry in stack)
    return numbers


def bot_slot_candidates(room: Room, player: Player) -> list[list[int]]:
    visible = bot_visible_numbers(room, player)
    candidates: list[list[int]] = []
    for slot, hidden_tile in enumerate(player.tiles):
        slot_candidates: list[int] = []
        for num in range(1, 61):
            if number_color_index(num) != hidden_tile.color_index:
                continue
            if num in visible:
                continue
            if any(
                (slot < notch_index and num >= clue.num) or (slot >= notch_index and num <= clue.num)
                for notch_index, notch in enumerate(player.notches)
                for clue in notch
            ):
                continue
            if any(
                (entry["isSame"] and number_dots(num) != entry["tile"].dots)
                or (not entry["isSame"] and number_dots(num) == entry["tile"].dots)
                for entry in player.compares[slot]
            ):
                continue
            slot_candidates.append(num)
        candidates.append(slot_candidates)
    return candidates


def bot_possible_assignments(room: Room, player: Player, limit: int = 2) -> tuple[list[list[int]], list[list[int]]]:
    if len(player.tiles) != 5:
        return [], []
    candidates = bot_slot_candidates(room, player)
    assignments: list[list[int]] = []

    def walk(slot: int, previous: int, chosen: list[int]) -> None:
        if len(assignments) >= limit:
            return
        if slot == len(candidates):
            assignments.append(list(chosen))
            return
        for num in candidates[slot]:
            if num <= previous or num in chosen:
                continue
            chosen.append(num)
            walk(slot + 1, num, chosen)
            chosen.pop()

    walk(0, 0, [])
    return assignments, candidates


def bot_certain_guess(room: Room, player: Player) -> list[int] | None:
    assignments, _ = bot_possible_assignments(room, player, limit=2)
    return assignments[0] if len(assignments) == 1 else None


def bot_best_compare_choice(room: Room, candidates: list[list[int]]) -> tuple[Tile, int, float] | None:
    best: tuple[Tile, int, float] | None = None
    for tile in room.center:
        for slot, slot_candidates in enumerate(candidates):
            if len(slot_candidates) < 2:
                continue
            yes = sum(1 for num in slot_candidates if number_dots(num) == tile.dots)
            no = len(slot_candidates) - yes
            if not yes or not no:
                continue
            balance = min(yes, no) / len(slot_candidates)
            score = balance * 4 + min(len(slot_candidates), 12) / 30
            if not best or score > best[2]:
                best = (tile, slot, score)
    return best


def bot_best_categorise_choice(room: Room, assignments: list[list[int]]) -> tuple[Tile, float] | None:
    if not assignments:
        return None
    best: tuple[Tile, float] | None = None
    for tile in room.center:
        buckets: dict[int, int] = {}
        for assignment in assignments:
            notch = sum(1 for num in assignment if tile.num > num)
            buckets[notch] = buckets.get(notch, 0) + 1
        if len(buckets) < 2:
            continue
        total = sum(buckets.values())
        balance = 1 - (max(buckets.values()) / total)
        score = (len(buckets) - 1) * 0.45 + balance * 1.4
        if not best or score > best[1]:
            best = (tile, score)
    return best


def bot_choose_responder(room: Room, player: Player) -> Player | None:
    responders = [item for item in room.players if item.active and item.id != player.id]
    if not responders:
        return None
    responders.sort(key=lambda item: (item.kind == "bot", item.seat))
    return responders[0]


def bot_choose_draw_color(room: Room, player: Player) -> int | None:
    available = [index for index, deck in enumerate(room.decks) if deck]
    if not available:
        return None
    return max(available, key=lambda index: (len(room.decks[index]), -index))


def summarize_match(room: Room) -> dict[str, Any]:
    duration = 0
    if room.started_at:
        duration = int((room.ended_at or time.time()) - room.started_at)
    rounds = round_info(room)
    return {
        "matchIndex": room.match_index,
        "matchTotal": room.match_total,
        "isSeriesFinal": room.match_index >= room.match_total,
        "durationSec": duration,
        "turns": room.turn_count,
        "rounds": rounds["completed"],
        "rankings": room.rankings,
        "actionCounts": match_action_counts(room.log),
        "timeline": room.log[-120:],
        "players": [
            {
                "id": player.id,
                "name": player.name,
                "color": player.color,
                "avatar": player.avatar,
                "tiles": [tile_public(tile) for tile in player.tiles],
                "stats": public_stats(player),
            }
            for player in room.players
        ],
    }


def summarize_series(room: Room) -> dict[str, Any]:
    return {
        "current": room.match_index,
        "total": room.match_total,
        "completed": len(room.match_history),
        "isFinal": room.status == "finished",
        "standings": series_standings(room),
        "history": room.match_history[-5:],
    }


def serialize_room(room: Room, viewer_player_id: str | None) -> dict[str, Any]:
    viewer = get_player(room, viewer_player_id)
    current = current_player(room)
    return {
        "room": {
            "code": room.code,
            "maxPlayers": room.max_players,
            "status": room.status,
            "phase": room.phase,
            "hostId": room.host_id,
            "revision": room.revision,
            "createdAt": int(room.created_at * 1000),
            "startedAt": int(room.started_at * 1000) if room.started_at else None,
            "endedAt": int(room.ended_at * 1000) if room.ended_at else None,
            "turnStartedAt": int(room.turn_started_at * 1000) if room.turn_started_at else None,
            "starterId": room.starter_id,
            "matchIndex": room.match_index,
            "matchTotal": room.match_total,
        },
        "me": {"id": viewer.id, "sessionToken": viewer.session_token} if viewer else None,
        "players": [serialize_player(room, player, viewer) for player in sorted(room.players, key=lambda item: item.seat)],
        "center": [tile_public(tile) for tile in room.center],
        "deckCounts": [len(deck) for deck in room.decks],
        "turnPlayerId": current.id if current else None,
        "turnCount": room.turn_count,
        "round": round_info(room),
        "log": room.log[-80:],
        "chat": room.chat[-80:],
        "marks": sorted(viewer.marks) if viewer else [],
        "match": summarize_match(room) if room.status in {"finished", "between_matches"} else None,
        "series": summarize_series(room),
        "playerColors": PLAYER_COLORS,
    }


def broadcast_room(room: Room, event: str = "state", extra: Any = None) -> None:
    clients = list(room.clients)
    for client in clients:
        if not client.alive:
            continue
        data = serialize_room(room, client.player_id)
        if extra is not None:
            data["eventData"] = extra
        client.send(event, data)


def send_error(client: Client, message: str) -> None:
    client.send("error", {"message": message})


def leave_current_room(client: Client) -> None:
    if not client.room_code:
        return
    room = ROOMS.get(client.room_code)
    if not room:
        client.room_code = None
        client.player_id = None
        return
    room.clients.discard(client)
    player = get_player(room, client.player_id)
    if player and player.kind == "human":
        player.connected = False
        player.disconnected_at = time.time()
        room.revision += 1
        add_log(room, "system", None, f"{player.name} หลุดการเชื่อมต่อ")
    broadcast_room(room)
    client.room_code = None
    client.player_id = None


def handle_create_room(client: Client, data: dict[str, Any]) -> None:
    require_owner_key(data)
    leave_current_room(client)
    max_players = int(data.get("maxPlayers") or 4)
    max_players = min(4, max(2, max_players))
    match_total = sanitize_match_total(data.get("matchTotal"))
    with ROOMS_LOCK:
        requested_code = sanitize_room_code(data.get("roomCode", ""), allow_empty=True)
        code = requested_code or make_room_code()
        lookup_key = room_lookup_key(code)
        if lookup_key in ROOMS:
            raise GameError("รหัสห้องนี้ถูกใช้แล้ว ลองตั้งชื่ออื่น")
        player = create_player(
            sanitize_name(data.get("name", "Host")),
            valid_color(data.get("color", "cyan")),
            seat=0,
            avatar=data.get("avatar", ""),
        )
        room = Room(code=code, max_players=max_players, host_id=player.id, players=[player], match_total=match_total)
        room.clients.add(client)
        ROOMS[lookup_key] = room
        client.room_code = lookup_key
        client.player_id = player.id
        add_log(room, "system", None, f"{player.name} สร้างห้อง {code}")
        client.send("roomJoined", serialize_room(room, player.id))


def handle_update_settings(client: Client, data: dict[str, Any]) -> None:
    room = require_room(client)
    player = require_player(room, client)
    if player.id != room.host_id:
        raise GameError("เฉพาะเจ้าของห้องเท่านั้น")
    if room.status != "lobby":
        raise GameError("แก้จำนวนเกมได้เฉพาะใน Lobby")
    room.match_total = sanitize_match_total(data.get("matchTotal", room.match_total))
    room.revision += 1
    broadcast_room(room)


def handle_join_room(client: Client, data: dict[str, Any]) -> None:
    code = sanitize_room_code(data.get("code", ""))
    lookup_key = room_lookup_key(code)
    with ROOMS_LOCK:
        room = ROOMS.get(lookup_key)
        if not room:
            raise GameError("ไม่พบห้องนี้")
        leave_current_room(client)

        session = str(data.get("sessionToken") or "")
        reconnect = next((player for player in room.players if player.session_token == session and player.kind == "human"), None)
        if reconnect:
            player = reconnect
            player.connected = True
            player.disconnected_at = None
            if "avatar" in data:
                reconnect_avatar = sanitize_avatar(data.get("avatar", ""))
                if reconnect_avatar:
                    player.avatar = reconnect_avatar
        else:
            if room.status != "lobby":
                raise GameError("เกมเริ่มแล้ว เข้าห้องใหม่ไม่ได้")
            if len(room.players) >= room.max_players:
                raise GameError("ห้องเต็มแล้ว")
            color = first_available_color(room, valid_color(data.get("color", "cyan")))
            player = create_player(
                sanitize_name(data.get("name", "Player")),
                color,
                seat=len(room.players),
                avatar=data.get("avatar", ""),
            )
            room.players.append(player)
            add_log(room, "system", None, f"{player.name} เข้าห้อง")

        room.clients.add(client)
        client.room_code = lookup_key
        client.player_id = player.id
        room.revision += 1
        client.send("roomJoined", serialize_room(room, player.id))
        broadcast_room(room)


def handle_update_profile(client: Client, data: dict[str, Any]) -> None:
    room = require_room(client)
    player = require_player(room, client)
    if room.status != "lobby":
        raise GameError("แก้โปรไฟล์ได้เฉพาะใน Lobby")
    player.name = sanitize_name(data.get("name", player.name))
    player.color = first_available_color(room, valid_color(data.get("color", player.color)), except_player_id=player.id)
    if "avatar" in data:
        player.avatar = sanitize_avatar(data.get("avatar", ""))
    room.revision += 1
    broadcast_room(room)


def handle_add_bot(client: Client) -> None:
    room = require_room(client)
    player = require_player(room, client)
    if player.id != room.host_id:
        raise GameError("เฉพาะเจ้าของห้องเท่านั้น")
    if room.status != "lobby":
        raise GameError("เพิ่ม Bot ได้เฉพาะใน Lobby")
    if len(room.players) >= room.max_players:
        raise GameError("ห้องเต็มแล้ว")
    bot_names = ["Nora", "Mika", "Taro", "Jin"]
    color = first_available_color(room, PLAYER_COLORS[len(room.players) % len(PLAYER_COLORS)]["key"])
    bot = create_player(bot_names[len(room.players) % len(bot_names)], color, seat=len(room.players), kind="bot")
    bot.connected = True
    room.players.append(bot)
    room.revision += 1
    add_log(room, "system", None, f"เพิ่ม Bot {bot.name}")
    broadcast_room(room)


def handle_remove_bot(client: Client, data: dict[str, Any]) -> None:
    room = require_room(client)
    player = require_player(room, client)
    if player.id != room.host_id:
        raise GameError("เฉพาะเจ้าของห้องเท่านั้น")
    if room.status != "lobby":
        raise GameError("ลบ Bot ได้เฉพาะใน Lobby")
    bot_id = str(data.get("playerId", ""))
    bot = get_player(room, bot_id)
    if not bot or bot.kind != "bot":
        raise GameError("ไม่พบ Bot")
    room.players = [item for item in room.players if item.id != bot.id]
    for seat, item in enumerate(room.players):
        item.seat = seat
    room.revision += 1
    add_log(room, "system", None, f"ลบ Bot {bot.name}")
    broadcast_room(room)


def handle_start_game(client: Client) -> None:
    room = require_room(client)
    player = require_player(room, client)
    if player.id != room.host_id:
        raise GameError("เฉพาะเจ้าของห้องเท่านั้น")
    start_room_game(room)
    broadcast_room(room)
    maybe_schedule_bot_turn(room)


def handle_next_match(client: Client) -> None:
    room = require_room(client)
    player = require_player(room, client)
    if player.id != room.host_id:
        raise GameError("เฉพาะเจ้าของห้องเท่านั้น")
    if room.status != "between_matches":
        raise GameError("ยังไม่ถึงช่วงเริ่มเกมถัดไป")
    start_room_game(room)
    broadcast_room(room)
    maybe_schedule_bot_turn(room)


def handle_restart(client: Client) -> None:
    room = require_room(client)
    player = require_player(room, client)
    if player.id != room.host_id:
        raise GameError("เฉพาะเจ้าของห้องเท่านั้น")
    restart_room_to_lobby(room)
    broadcast_room(room)


def handle_action(client: Client, data: dict[str, Any]) -> None:
    room = require_room(client)
    player = require_player(room, client)
    action_type = data.get("type")
    animation: dict[str, Any] | None = None
    if action_type == "draw":
        result = apply_draw(room, player, data.get("colorIndex"))
        animation = {"type": "draw", "actorId": player.id, **result}
    elif action_type == "categorise":
        result = apply_categorise(room, player, data.get("responderId"), data.get("centerTileId"))
        animation = {"type": "categorise", "actorId": player.id, **result}
    elif action_type == "compare":
        result = apply_compare(room, player, data.get("responderId"), data.get("centerTileId"), data.get("slotIndex"))
        animation = {"type": "compare", "actorId": player.id, **result}
    else:
        raise GameError("ไม่รู้จัก action นี้")
    broadcast_room(room, "state", animation)
    maybe_schedule_bot_turn(room)


def handle_mark(client: Client, data: dict[str, Any]) -> None:
    room = require_room(client)
    player = require_player(room, client)
    apply_mark(player, data.get("num"), data.get("marked"))
    room.revision += 1
    client.send("state", serialize_room(room, player.id))


def handle_chat(client: Client, data: dict[str, Any]) -> None:
    room = require_room(client)
    player = require_player(room, client)
    message = sanitize_chat(data.get("message", ""))
    if not message:
        return
    item = {
        "id": secrets.token_urlsafe(6),
        "time": now_ms(),
        "playerId": player.id,
        "name": player.name,
        "color": player.color,
        "avatar": player.avatar,
        "message": message,
        "spectator": not player.active and room.status == "playing",
    }
    room.chat.append(item)
    room.chat = room.chat[-120:]
    broadcast_room(room, "chat", {"chat": room.chat[-80:]})


def handle_guess(client: Client, data: dict[str, Any]) -> None:
    room = require_room(client)
    player = require_player(room, client)
    result = apply_guess(room, player, data.get("guess"))
    client.send("guessResult", result)
    broadcast_room(room)
    maybe_schedule_bot_turn(room)


def require_room(client: Client) -> Room:
    if not client.room_code or client.room_code not in ROOMS:
        raise GameError("คุณยังไม่ได้อยู่ในห้อง")
    return ROOMS[client.room_code]


def require_player(room: Room, client: Client) -> Player:
    player = get_player(room, client.player_id)
    if not player:
        raise GameError("ไม่พบผู้เล่นของคุณ")
    return player


def handle_message(client: Client, message: str) -> None:
    message = message.strip()
    if not message:
        return
    try:
        try:
            packet = json.loads(message)
        except json.JSONDecodeError as exc:
            print(f"Ignoring invalid WebSocket JSON: {exc}; sample={message[:120]!r}")
            send_error(client, "ข้อมูลจาก browser มาไม่ครบ ลองกดอีกครั้งหรือรีเฟรชหน้าเว็บ")
            return
        event = packet.get("event")
        data = packet.get("data") or {}
        if not isinstance(data, dict):
            data = {}
        with ROOMS_LOCK:
            if event == "createRoom":
                handle_create_room(client, data)
            elif event == "joinRoom":
                handle_join_room(client, data)
            elif event == "updateSettings":
                handle_update_settings(client, data)
            elif event == "updateProfile":
                handle_update_profile(client, data)
            elif event == "addBot":
                handle_add_bot(client)
            elif event == "removeBot":
                handle_remove_bot(client, data)
            elif event == "startGame":
                handle_start_game(client)
            elif event == "nextMatch":
                handle_next_match(client)
            elif event == "restart":
                handle_restart(client)
            elif event == "action":
                handle_action(client, data)
            elif event == "mark":
                handle_mark(client, data)
            elif event == "chat":
                handle_chat(client, data)
            elif event == "gotFive":
                handle_guess(client, data)
            elif event == "sync":
                room = require_room(client)
                client.send("state", serialize_room(room, client.player_id))
            else:
                raise GameError("ไม่รู้จัก event นี้")
    except GameError as exc:
        send_error(client, str(exc))
    except Exception as exc:  # pragma: no cover - intentionally defensive for live server.
        traceback.print_exc()
        send_error(client, f"เกิดข้อผิดพลาด: {exc}")


def maybe_schedule_bot_turn(room: Room) -> None:
    if room.status != "playing":
        return
    player = current_player(room)
    if not player or player.kind != "bot" or not player.active:
        return

    def run_bot() -> None:
        with ROOMS_LOCK:
            try:
                if room.status != "playing" or current_player(room) is not player:
                    return
                run_bot_turn(room, player)
                broadcast_room(room)
                maybe_schedule_bot_turn(room)
            except Exception:
                traceback.print_exc()
                add_log(room, "system", None, f"Bot {player.name} ทำงานพลาด ข้ามตา")
                end_turn(room, count_turn=False)
                broadcast_room(room)

    timer = threading.Timer(1.2, run_bot)
    timer.daemon = True
    room.bot_timers.append(timer)
    timer.start()


def run_bot_turn(room: Room, player: Player) -> None:
    certain_guess = bot_certain_guess(room, player)
    if certain_guess:
        apply_guess(room, player, certain_guess)
        return

    if room.phase == "draw":
        draw_color = bot_choose_draw_color(room, player)
        if draw_color is not None:
            apply_draw(room, player, draw_color)
        elif room.center:
            room.phase = "action"
        else:
            finish_room(room, winner_id=None, reason="no_tiles")
            return

    if room.status != "playing" or room.phase != "action" or not room.center:
        return

    responder = bot_choose_responder(room, player)
    if not responder:
        end_turn(room)
        return

    assignments, candidates = bot_possible_assignments(room, player, limit=80)
    compare_choice = bot_best_compare_choice(room, candidates)
    categorise_choice = bot_best_categorise_choice(room, assignments)
    if compare_choice and (not categorise_choice or compare_choice[2] >= categorise_choice[1]):
        tile, slot, _score = compare_choice
        apply_compare(room, player, responder.id, tile.id, slot)
    elif categorise_choice:
        tile, _score = categorise_choice
        apply_categorise(room, player, responder.id, tile.id)
    elif compare_choice:
        tile, slot, _score = compare_choice
        apply_compare(room, player, responder.id, tile.id, slot)
    else:
        tile = random.choice(room.center)
        apply_categorise(room, player, responder.id, tile.id)


class GotFiveHandler(BaseHTTPRequestHandler):
    server_version = "GotFiveWebSocket/1.0"

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self.send_json_http({"ok": True, "rooms": len(ROOMS)})
            return
        if parsed.path == "/ws":
            self.handle_websocket()
            return
        self.serve_static(parsed.path)

    def send_json_http(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, request_path: str) -> None:
        if request_path in {"/", "/owner"} or request_path.startswith("/room/"):
            file_path = PUBLIC_DIR / "index.html"
        else:
            relative = urllib.parse.unquote(request_path.lstrip("/"))
            file_path = (PUBLIC_DIR / relative).resolve()
            public_root = PUBLIC_DIR.resolve()
            if public_root not in file_path.parents and file_path != public_root:
                self.send_error(403)
                return
        if not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return
        content_type, _ = mimetypes.guess_type(str(file_path))
        if file_path.suffix == ".js":
            content_type = "application/javascript"
        if file_path.suffix == ".css":
            content_type = "text/css"
        body = file_path.read_bytes()
        self.send_response(200)
        content_type = content_type or "application/octet-stream"
        if content_type.startswith("text/") or content_type == "application/javascript":
            content_type = f"{content_type}; charset=utf-8"
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_websocket(self) -> None:
        if self.headers.get("Upgrade", "").lower() != "websocket":
            self.send_error(400)
            return
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self.send_error(400)
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

        client = Client(self)
        client.send("connected", {"clientId": client.id})
        try:
            while client.alive:
                message = self.read_ws_text()
                if message is None:
                    break
                handle_message(client, message)
        finally:
            client.alive = False
            with ROOMS_LOCK:
                leave_current_room(client)

    def read_exactly(self, length: int) -> bytes | None:
        chunks = bytearray()
        while len(chunks) < length:
            chunk = self.rfile.read(length - len(chunks))
            if not chunk:
                return None
            chunks.extend(chunk)
        return bytes(chunks)

    def read_ws_frame(self) -> tuple[bool, int, bytes] | None:
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

    def read_ws_text(self) -> str | None:
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

    def send_ws_text(self, payload: bytes) -> None:
        self.send_ws_frame(payload, opcode=0x1)

    def send_ws_frame(self, payload: bytes, opcode: int = 0x1) -> None:
        length = len(payload)
        header = bytearray([0x80 | opcode])
        if length < 126:
            header.append(length)
        elif length < 65536:
            header.append(126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(127)
            header.extend(struct.pack("!Q", length))
        self.wfile.write(bytes(header) + payload)
        self.wfile.flush()

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")


def run() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), GotFiveHandler)
    httpd.daemon_threads = True
    actual_host, actual_port = httpd.server_address
    print(f"GOT FIVE! realtime server running at http://{actual_host}:{actual_port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    run()
